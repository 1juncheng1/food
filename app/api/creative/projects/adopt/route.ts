import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'

export const maxDuration = 20
export const dynamic = 'force-dynamic'

/**
 * POST /api/creative/projects/adopt
 * 第三阶段：把一篇"老作品"（创作进化系统上线前生成、只有 localStorage /
 * 可能有反馈延迟创建的 generation_history 散行）纳入持续创作体系。
 *
 * 做且只做一件事：新建 creative_projects + 写入 V1 版本行（id = `${pid}::v1`），
 * 之后该作品即与阶段 2-5 的蓝图/版本/诊断/迭代/定稿链路完全同构，
 * 前端无需任何"老作品专属"分支。
 *
 * 幂等：若 generationId 对应行已挂在某项目下，直接返回既有归属（重复点击不重复建项目）。
 * 旧的散行（反馈延迟创建）原样保留，不迁移、不删除，避免破坏历史反馈记录。
 */

interface AdoptBody {
  generationId?: unknown // 本地作品 id（可能对应一条无 project_id 的 generation_history）
  title?: unknown
  content?: unknown
  identityLabel?: unknown
  style?: unknown
  category?: unknown
  systemPrompt?: unknown
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

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
      return NextResponse.json({ error: '登录已过期' }, { status: 401 })
    }

    const body = (await req.json().catch(() => ({}))) as AdoptBody
    const title = str(body.title, 200)
    const content = str(body.content, 100000)
    if (!title) return NextResponse.json({ error: '缺少作品标题' }, { status: 400 })
    if (!content) return NextResponse.json({ error: '缺少作品内容' }, { status: 400 })

    const legacyId = str(body.generationId, 100)
    const identityLabel = str(body.identityLabel, 200)
    const style = str(body.style, 500)
    const category = str(body.category, 100)
    const systemPrompt = str(body.systemPrompt, 20000)

    // ── 幂等：旧行已归属某项目（重复 adopt / 多标签页并发）→ 直接返回既有归属 ──
    if (legacyId) {
      const { data: existing } = await supabase
        .from('generation_history')
        .select('project_id, version_number')
        .eq('id', legacyId)
        .maybeSingle()
      if (existing?.project_id) {
        const pid = existing.project_id as string
        const vn = Number(existing.version_number ?? 1)
        return NextResponse.json({
          ok: true,
          adopted: false,
          projectId: pid,
          versionId: `${pid}::v${vn}`,
          versionNumber: vn,
        })
      }
    }

    // ── 新建创作项目（status 默认 active，current_version=1）──
    const { data: newProject, error: projectErr } = await supabase
      .from('creative_projects')
      .insert({
        user_id: user.id,
        title,
        topic: title,
        status: 'active',
        current_version: 1,
      })
      .select('id')
      .single()

    if (projectErr || !newProject) {
      console.error('adopt：创作项目创建失败:', projectErr)
      return NextResponse.json({ error: '纳入失败，请稍后重试' }, { status: 500 })
    }

    const pid = newProject.id as string
    const versionId = `${pid}::v1`

    // ── 写入 V1：内容/参数全部来自老作品；blueprint/analysis 留空，
    //    前端纳入后会自动触发五维诊断（既有 analyze 链路），蓝图对老版本非必需 ──
    const { error: insertErr } = await supabase.from('generation_history').insert({
      id: versionId,
      user_id: user.id,
      project_id: pid,
      version_number: 1,
      topic: title,
      identity_label: identityLabel || null,
      style: style || null,
      category: category || null,
      system_prompt: systemPrompt || null,
      sample_text: content,
      feedback_status: null,
      blueprint: null,
      analysis: null,
    })

    if (insertErr) {
      console.error('adopt：V1 写入失败:', insertErr)
      return NextResponse.json({ error: '纳入失败，请稍后重试' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      adopted: true,
      projectId: pid,
      versionId,
      versionNumber: 1,
    })
  } catch (error) {
    console.error('adopt API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
