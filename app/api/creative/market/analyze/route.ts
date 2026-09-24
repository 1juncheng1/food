// ============================================================
// POST /api/creative/market/analyze —— 内容市场分析
//
// 输入：{ raw_input: string, competition_level?: number, competition_reason?: string, content_domain?: string }
// 输出：{ report: MarketReport }
//
// 流程：
//   1. 可选鉴权（游客可分析，与灵感分析同口径）
//   2. 限流：6 次/分钟（比灵感分析严——每次多一次 LLM 调用，成本更高）
//   3. 调 getMarketProvider().analyze（MVP 为 DeepSeek 估算，反幻觉硬约束）
//   4. LLM 失败返回 502，前端提示重试
// ============================================================

import { NextResponse } from 'next/server'
import { aiFailureResponse } from '@/lib/apiAuth'
import { hasEnoughFor } from '@/lib/aiCost'
import { INSUFFICIENT_POINTS_MESSAGE } from '@/lib/points'
import { rateLimit } from '@/lib/rateLimit'
import { authenticateWithToken } from '@/lib/storage'
import { getMarketProvider } from '@/lib/creative/marketAnalyzer'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

const RATE_LIMIT = 6
const RATE_WINDOW_MS = 60_000

interface RequestBody {
  raw_input?: unknown
  competition_level?: unknown
  competition_reason?: unknown
  content_domain?: unknown
}

function str(v: unknown, maxLen: number): string {
  return typeof v === 'string' ? v.trim().slice(0, maxLen) : ''
}

export async function POST(req: Request) {
  try {
    // ── 强制鉴权：游客不可使用市场分析 ──
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const auth = await authenticateWithToken(token, '请先登录后再进行市场分析')
    if (!auth.ok) return auth.response

    // ── 限流：登录按 userId ──
    const rateKey = `market:${auth.userId}`
    const limit = rateLimit(rateKey, RATE_LIMIT, RATE_WINDOW_MS)
    if (!limit.ok) {
      return NextResponse.json(
        { error: `操作太频繁，请 ${limit.retryAfterSec} 秒后再试` },
        { status: 429 }
      )
    }

    const body = (await req.json().catch(() => ({}))) as RequestBody
    const rawInput = str(body.raw_input, 2000)
    if (!rawInput) {
      return NextResponse.json({ error: '请填写灵感内容' }, { status: 400 })
    }
    if (rawInput.length < 2) {
      return NextResponse.json({ error: '灵感内容太短，至少 2 个字' }, { status: 400 })
    }

    // 竞争度种子（可选，来自灵感分析）
    const competitionLevelNum = Number(body.competition_level)
    const competitionLevel = Number.isFinite(competitionLevelNum)
      ? Math.max(1, Math.min(10, Math.round(competitionLevelNum)))
      : undefined
    const competitionReason = str(body.competition_reason, 200) || undefined
    const contentDomain = str(body.content_domain, 40) || undefined

    // ── 余额预检 ──
    // 只为让余额不足时返回 402「请充值」，而不是含糊的 502「分析失败」。
    // 它不替代扣费——真正的并发安全由 LLM 层的预扣那一刀保证。
    const budget = await hasEnoughFor(auth.supabase, auth.userId, 'diagnosis')
    if (!budget.ok) {
      return NextResponse.json(
        { error: INSUFFICIENT_POINTS_MESSAGE, code: 'insufficient_balance' },
        { status: 402 }
      )
    }

    // ── 调市场分析 Provider（计费：预扣 → 按真实用量结算 / 失败全额退）──
    // 估算模式与真实数据模式走同一条计费链路；
    // web_search 数据层不可用回退估算时，同样计费（成本一分没少）。
    const provider = getMarketProvider()
    const report = await provider.analyze(
      {
        raw_input: rawInput,
        competition_level: competitionLevel,
        competition_reason: competitionReason,
        content_domain: contentDomain,
      },
      {
        supabase: auth.supabase,
        userId: auth.userId,
        refId: crypto.randomUUID(),
      }
    )
    if (!report) {
      return await aiFailureResponse('市场分析失败，请稍后重试')
    }

    return NextResponse.json({ report })
  } catch (error) {
    console.error('market analyze API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
