// ============================================================
// POST /api/creative/work-tags —— 作品标签分析（阶段 5）
//
// 前端在 prompt-optimizer 返回后异步 fetch，不阻塞主流程。
// 可选鉴权：登录用户结果幂等写入 generation_history.work_tags（jsonb）；
//          游客直接返回，不落库。
// 失败静默降级：返回 null，前端不展示标签卡。
//
// 与 /api/creative/analyze（AI 诊断报告）职责分离：
//   analyze → 优势/不足/优化建议（必须登录）
//   work-tags → 9 维度结构化标签（可选登录，含 thought/usage 枚举维度对齐 KnowledgeItem）
// ============================================================

import { NextResponse } from 'next/server'
import { authenticateWithToken } from '@/lib/storage'
import { rateLimit, getClientIp } from '@/lib/rateLimit'
import {
  analyzeWorkTags,
  normalizeWorkTags,
  type WorkTags,
} from '@/lib/creative/workAnalysis'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000

interface RequestBody {
  generationId?: unknown // generation_history 行 id（可选，用于登录用户落库）
  sampleText?: unknown // 作品正文（必填，游客模式只传这个）
  topic?: unknown // 创作主题（辅助判断，可选）
  force?: unknown // true = 忽略已有标签重新分析
}

function str(v: unknown, maxLen: number): string {
  return typeof v === 'string' ? v.trim().slice(0, maxLen) : ''
}

export async function POST(req: Request) {
  try {
    // ── 可选鉴权：登录则查行落库；游客直接返回 ──
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const auth = token ? await authenticateWithToken(token) : null

    // ── 限流：登录按 userId，游客按 IP（每次调用都是一次真实 LLM 请求）──
    const rateKey = auth ? `tags:${auth.userId}` : `tags:guest:${getClientIp(req)}`
    const rl = rateLimit(rateKey, RATE_LIMIT, RATE_WINDOW_MS)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `操作太频繁，请 ${rl.retryAfterSec} 秒后再试` },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    const body = (await req.json().catch(() => ({}))) as RequestBody
    const sampleText = str(body.sampleText, 10000)
    if (!sampleText) {
      return NextResponse.json({ error: '缺少作品正文' }, { status: 400 })
    }

    const force = body.force === true
    const generationId = str(body.generationId, 200)
    const topic = str(body.topic, 500)

    // ── 登录用户：查行，有缓存且非 force 则直接返回 ──
    if (auth && generationId && !force) {
      const { data: row, error: rowErr } = await auth.supabase
        .from('generation_history')
        .select('work_tags')
        .eq('id', generationId)
        .eq('user_id', auth.userId)
        .maybeSingle()

      if (rowErr) {
        console.error('标签缓存查询失败:', rowErr.message)
      } else if (row) {
        const cached = normalizeWorkTags(row.work_tags)
        if (cached) {
          return NextResponse.json({ tags: cached, cached: true })
        }
      }
    }

    // ── 调 LLM 分析标签 ──
    const tags: WorkTags | null = await analyzeWorkTags({
      sampleText,
      topic: topic || undefined,
    })
    if (!tags) {
      return NextResponse.json(
        { error: '标签分析失败，请稍后重试' },
        { status: 502 }
      )
    }

    // ── 登录用户：幂等落库 ──
    if (auth && generationId) {
      const { error: updateErr } = await auth.supabase
        .from('generation_history')
        .update({
          work_tags: { ...tags, analyzedAt: new Date().toISOString() },
        })
        .eq('id', generationId)
        .eq('user_id', auth.userId)
      if (updateErr) {
        console.error('标签写库失败（结果仍返回给前端）:', updateErr.message)
      }
    }

    return NextResponse.json({ tags, cached: false })
  } catch (error) {
    console.error('work-tags API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
