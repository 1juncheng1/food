// ============================================================
// POST /api/inspirations/events —— 推荐反馈事件端点（WF1）
//
// 推荐闭环的数据入口：dashboard 每张个性化卡的曝光/点击/✕ 都从这进。
//   impression → recommend_impression（权重 0，只做 CTR 分母，按天幂等）
//   click      → recommend_click（0.15，带卡片主题，按天幂等）
//   dismiss    → recommend_dismiss（-1.5）+ 卡片离队 + 补算主题向量
//                （让负反馈精确落进对应兴趣簇）+ fire-and-forget 增量重建
//
// 原则：任何下游失败都不影响 200 响应（trackEvent 内部已吞错）；
// 前端对响应也不等待不重试（keepalive 上报）。
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import { getSuggestionById, markDismissed } from '@/lib/creative/interest/suggestionRepo'
import { trackEvent } from '@/lib/creative/interest/eventTracker'
import { runBuild } from '@/lib/creative/interest/builder'
import { generateEmbedding } from '@/lib/storage'
import { rateLimit } from '@/lib/rateLimit'
import { afterResponse } from '@/lib/afterResponse'
import {
  EVENT_RATE_LIMIT_PER_MIN,
  DISMISS_REASON_CODES,
  type DismissReasonCode,
} from '@/lib/creative/interest/config'
import type { CreatorEventType } from '@/lib/creative/interest/types'

export const dynamic = 'force-dynamic'
// dismiss 后会挂一个 20–150s 的增量重建，需要实例存活窗口
export const maxDuration = 60

const VALID_TYPES = ['impression', 'click', 'dismiss'] as const
type RecEventType = (typeof VALID_TYPES)[number]

const TYPE_TO_EVENT: Record<RecEventType, CreatorEventType> = {
  impression: 'recommend_impression',
  click: 'recommend_click',
  dismiss: 'recommend_dismiss',
}

export async function POST(req: Request) {
  try {
    // ── 鉴权：游客没有推荐卡，也就没有反馈 ──
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const supabase = createServerClient(token)
    const { data: userData, error: authErr } = await supabase.auth.getUser()
    if (authErr || !userData.user) {
      return authFailureResponse(authErr)
    }
    const userId = userData.user.id

    // ── 每用户限流（防前端 bug 刷库）──
    const rl = rateLimit(`rec-events:${userId}`, EVENT_RATE_LIMIT_PER_MIN, 60_000)
    if (!rl.ok) {
      return NextResponse.json({ error: '上报过于频繁' }, { status: 429 })
    }

    // ── 入参校验 ──
    const body = (await req.json().catch(() => ({}))) as {
      type?: unknown
      rec_id?: unknown
      reason?: unknown
    }
    const type = body.type
    const recId = typeof body.rec_id === 'string' ? body.rec_id.trim() : ''
    // ✕ 的原因（可选）：Taste Model 的原料。不参与兴趣权重，只作为"为什么不要"的证据。
    // 非法值一律丢弃而非报错——反馈比原因码重要，不能因为多传一个字段就把 -1.5 丢掉。
    const reason: DismissReasonCode | null =
      typeof body.reason === 'string' &&
      (DISMISS_REASON_CODES as readonly string[]).includes(body.reason)
        ? (body.reason as DismissReasonCode)
        : null
    if (typeof type !== 'string' || !VALID_TYPES.includes(type as RecEventType)) {
      return NextResponse.json({ error: '无效的反馈类型' }, { status: 400 })
    }
    if (!recId || recId.length > 64) {
      return NextResponse.json({ error: '无效的推荐 ID' }, { status: 400 })
    }
    const eventType = TYPE_TO_EVENT[type as RecEventType]

    if (type === 'dismiss') {
      // ✕：校验归属（不存在/非本人 → 404），卡片离队 + 负反馈事件 + 重建
      const card = await getSuggestionById(supabase, recId, userId)
      if (!card) {
        return NextResponse.json({ error: '推荐卡不存在' }, { status: 404 })
      }
      await markDismissed(supabase, recId)

      // 主题向量让 -1.5 精确落到对应兴趣簇；失败置 null（事件照常入账）
      let embedding: number[] | null = null
      try {
        embedding = await generateEmbedding(card.topic)
      } catch {
        embedding = null
      }
      await trackEvent(supabase, userId, {
        type: eventType,
        targetType: 'inspiration',
        targetId: recId,
        topicExcerpt: card.topic || null,
        embedding,
        payload: {
          title: card.title,
          cluster_code: card.cluster_code,
          slot: card.slot,
          ...(reason ? { reason_code: reason } : {}),
        },
      })

      // 走 afterResponse：void 的后台 build 在 serverless 上会被响应后的冻结掐断，
      // 表现为"点了不感兴趣，下次刷新还是那几张"。
      afterResponse(() => runBuild(supabase, userId, 'incremental').catch(() => {}))
    } else {
      // 曝光/点击：不改队列状态（consumed 发生在 plan 采纳时）；
      // dailyKey 让同卡同天反复上报被幂等吞掉
      await trackEvent(supabase, userId, {
        type: eventType,
        targetType: 'inspiration',
        targetId: recId,
        dailyKey: true,
      })
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error(
      'inspirations events API 错误:',
      e instanceof Error ? e.message : e
    )
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
