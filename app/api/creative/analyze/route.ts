import { NextResponse } from 'next/server'
import { authFailureResponse } from '@/lib/apiAuth'
import { createServerClient } from '@/lib/supabaseServer'
import {
  blueprintFromRaw,
  generateDiagnosis,
  parseDiagnosis,
  type CreativeDiagnosis,
} from '@/lib/creative/diagnosis'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

interface RequestBody {
  generationId?: unknown // generation_history 行 id（项目版本为 pid::vN，老作品为前端 uuid）
  force?: unknown // true = 忽略已有诊断重新分析
}

function str(v: unknown, maxLen: number): string {
  return typeof v === 'string' ? v.trim().slice(0, maxLen) : ''
}

/**
 * POST /api/creative/analyze
 * 创作进化系统阶段 4：对一篇已生成作品做五维 AI 诊断，结果写入
 * generation_history.analysis（jsonb）。仅登录用户、仅能诊断自己的作品
 * （RLS + 显式归属双保险）。已有诊断时幂等返回，force=true 才重新计费分析。
 */
export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const supabase = createServerClient(token)
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token)
    if (authErr || !user) {
      return authFailureResponse(authErr)
    }

    const body = (await req.json().catch(() => ({}))) as RequestBody
    const generationId = str(body.generationId, 200)
    if (!generationId) {
      return NextResponse.json({ error: '缺少作品 ID' }, { status: 400 })
    }
    const force = body.force === true

    // ── 定位作品行（RLS 已限定本人；maybeSingle 在无行/他人行时都返回 null）──
    const { data: row, error: rowErr } = await supabase
      .from('generation_history')
      .select(
        'id, user_id, topic, identity_label, style, category, sample_text, blueprint, analysis'
      )
      .eq('id', generationId)
      .maybeSingle()

    if (rowErr) {
      console.error('查询待诊断作品失败:', rowErr)
      return NextResponse.json({ error: '查询失败' }, { status: 500 })
    }
    if (!row || row.user_id !== user.id) {
      return NextResponse.json({ error: '作品不存在' }, { status: 404 })
    }
    const sampleText = typeof row.sample_text === 'string' ? row.sample_text : ''
    if (!sampleText.trim()) {
      return NextResponse.json({ error: '作品内容为空，无法诊断' }, { status: 400 })
    }

    // ── 幂等：已有诊断直接返回（前端刷新/切换版本不重复消耗 LLM）──
    if (!force && row.analysis) {
      const cached = parseDiagnosis(row.analysis)
      if (cached) {
        return NextResponse.json({ analysis: cached, cached: true })
      }
    }

    // ── 调用诊断 LLM ──
    const result = await generateDiagnosis({
      topic: str(row.topic, 500),
      identityLabel: str(row.identity_label, 200),
      style: str(row.style, 500),
      category: str(row.category, 100),
      blueprint: blueprintFromRaw(row.blueprint),
      sampleText,
    })
    if (!result) {
      return NextResponse.json({ error: '诊断失败，请稍后重试' }, { status: 502 })
    }

    const analysis: CreativeDiagnosis = {
      ...result,
      diagnosedAt: new Date().toISOString(),
    }

    // ── 写回 analysis（写失败不影响本次返回，下次 force 重试即可）──
    const { error: updateErr } = await supabase
      .from('generation_history')
      .update({ analysis })
      .eq('id', generationId)
    if (updateErr) {
      console.error('诊断结果写库失败（结果仍返回给前端）:', updateErr)
    }

    return NextResponse.json({ analysis, cached: false })
  } catch (error) {
    console.error('creative analyze API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
