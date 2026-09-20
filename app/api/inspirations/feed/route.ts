// ============================================================
// GET /api/inspirations/feed?cursor=&limit=10 —— 灵感无限流分页端点（WF11 P2）
//
// 游标分页读 active 推荐卡，排除当日已曝光/已 dismiss 的卡。
// 冷启动（无画像/队列空）→ 返回全局热点流。
// 库存 ≤8 → fire-and-forget 触发增量 build（补卡）。
// 日达 100 张上限 → { no_more: true, cards: [] }，不产生新 LLM 调用。
//
// 鉴权：必须登录（游客不进 Feed，dashboard 有模板卡入口）。
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { getProfile } from '@/lib/creative/interest/interestRepo'
import { findRunningBuild } from '@/lib/creative/interest/interestRepo'
import { runBuild } from '@/lib/creative/interest/builder'
import { buildReasonText } from '@/lib/creative/interest/reasonAi'
import { getGlobalTrending } from '@/lib/ci/globalTrending'
import {
  getFeedPage,
  getDailySuggestionCount,
  FEED_DAILY_CAP,
  FEED_TOPUP_THRESHOLD,
} from '@/lib/creative/interest/feedRepo'
import type { SuggestionRow } from '@/lib/creative/interest/suggestionRepo'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

interface FeedCard {
  rec_id: string
  title: string
  description: string
  reason: string
  topic: string
  params: { category: string; topic: string; rec_id: string }
  slot: string
  cluster_code: string
  score: number
  score_breakdown: Record<string, number>
  evidence: Record<string, unknown>
  // 降级卡（全局热点）无 AI 理由字段
  core_question?: string | null
  why_recommend?: string | null
  creation_angle?: string | null
  related_knowledge?: string[] | null
  reason_source?: string | null
  // Feed 专属：跨界灵感标记（来自 evidence.cross_exploration）
  cross_exploration?: boolean
}

/**
 * 把 SuggestionRow 映射为 Feed 响应卡（与 /api/inspirations GET 字段集一致）。
 * 额外提取 evidence.cross_exploration 供前端打「跨界灵感」标。
 */
function mapSuggestionToCard(r: SuggestionRow): FeedCard {
  const evidence = r.evidence ?? {}
  return {
    rec_id: r.id,
    title: r.title,
    description: r.description,
    reason: buildReasonText({
      slot: r.slot,
      clusterCode: r.cluster_code,
      evidence,
    }),
    topic: r.topic,
    params: { category: r.form_hint ?? '其他', topic: r.topic, rec_id: r.id },
    slot: r.slot,
    cluster_code: r.cluster_code,
    score: r.score,
    score_breakdown: r.score_breakdown ?? {},
    evidence,
    core_question: r.core_question ?? null,
    why_recommend: r.why_recommend ?? null,
    creation_angle: r.creation_angle ?? null,
    related_knowledge: r.related_knowledge ?? [],
    reason_source: r.reason_source ?? 'template',
    // evidence.cross_exploration 由 builder L459-577 写入（P1 step 11）
    cross_exploration: evidence.cross_exploration === true,
  }
}

export async function GET(req: Request) {
  try {
    // ── 鉴权：Feed 为登录态功能 ──
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const supabase = createServerClient(token)
    const { data: userData, error: authErr } = await supabase.auth.getUser()
    if (authErr || !userData.user) {
      return NextResponse.json({ error: '登录状态失效' }, { status: 401 })
    }
    const userId = userData.user.id

    // ── 解析查询参数 ──
    const url = new URL(req.url)
    const cursor = url.searchParams.get('cursor') ?? undefined
    const limitParam = url.searchParams.get('limit')
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 10, 1), 50) : 10

    // ── 日出卡上限检查（AC-6）──
    const dailyCount = await getDailySuggestionCount(supabase, userId)
    if (dailyCount >= FEED_DAILY_CAP) {
      return NextResponse.json({
        cards: [],
        next_cursor: null,
        no_more: true,
        daily_count: dailyCount,
        fallback_source: null,
      })
    }

    // ── 读画像（判断是否冷启动） ──
    const { profile } = await getProfile(supabase, userId)
    const hasProfile = profile && Object.keys(profile).length > 0 && (profile as Record<string, unknown>).build_id

    // ── 冷启动（无画像）→ 全局热点流 ──
    if (!hasProfile) {
      const trending = await getGlobalTrending(limit)
      const cards: FeedCard[] = trending.map((t) => ({
        rec_id: `trending-${t.title}`,
        title: t.title,
        description: t.description,
        reason: '当日全网热门创作方向',
        topic: t.title,
        params: { category: t.category, topic: t.title, rec_id: `trending-${t.title}` },
        slot: 'exploration',
        cluster_code: 'global_trending',
        score: 0,
        score_breakdown: {},
        evidence: { source: 'global_trending' },
        reason_source: 'template',
        cross_exploration: false,
      }))
      return NextResponse.json({
        cards,
        next_cursor: null, // 热点流不分页
        no_more: true,
        daily_count: dailyCount,
        fallback_source: 'trending' as const,
      })
    }

    // ── 读 Feed 页 ──
    const page = await getFeedPage(supabase, userId, { cursor, limit })

    // ── 队列空但有画像（build 刚 supersede 或尚未建完）→ 全局热点补 ──
    if (page.cards.length === 0 && page.remaining === 0) {
      const trending = await getGlobalTrending(limit)
      const cards: FeedCard[] = trending.map((t) => ({
        rec_id: `trending-${t.title}`,
        title: t.title,
        description: t.description,
        reason: '正在为你生成个性化选题，先看看今日热门',
        topic: t.title,
        params: { category: t.category, topic: t.title, rec_id: `trending-${t.title}` },
        slot: 'exploration',
        cluster_code: 'global_trending',
        score: 0,
        score_breakdown: {},
        evidence: { source: 'global_trending' },
        reason_source: 'template',
        cross_exploration: false,
      }))
      return NextResponse.json({
        cards,
        next_cursor: null,
        no_more: false, // 画像在，build 完成后会有新卡
        daily_count: dailyCount,
        fallback_source: 'trending' as const,
      })
    }

    // ── 补卡触发：库存 ≤8 且日未达上限且无在途 build → fire-and-forget ──
    if (
      page.remaining <= FEED_TOPUP_THRESHOLD &&
      dailyCount + limit < FEED_DAILY_CAP
    ) {
      const building = !!(await findRunningBuild(supabase, userId))
      if (!building) {
        void runBuild(supabase, userId, 'incremental').catch(() => {})
      }
    }

    // ── 正常返回 ──
    return NextResponse.json({
      cards: page.cards.map(mapSuggestionToCard),
      next_cursor: page.next_cursor,
      no_more: page.next_cursor === null && page.remaining <= FEED_TOPUP_THRESHOLD,
      daily_count: dailyCount,
      fallback_source: null,
    })
  } catch (error) {
    console.error('inspirations feed API 错误:', error instanceof Error ? error.message : error)
    // 任何异常都回退到全局热点，保证 500 率为 0
    try {
      const trending = await getGlobalTrending(10)
      return NextResponse.json({
        cards: trending.map((t) => ({
          rec_id: `trending-${t.title}`,
          title: t.title,
          description: t.description,
          reason: '暂时无法获取个性化推荐，先看看热门选题',
          topic: t.title,
          params: { category: t.category, topic: t.title, rec_id: `trending-${t.title}` },
          slot: 'exploration',
          cluster_code: 'global_trending',
          score: 0,
          score_breakdown: {},
          evidence: { source: 'global_trending' },
          reason_source: 'template',
          cross_exploration: false,
        })),
        next_cursor: null,
        no_more: true,
        daily_count: 0,
        fallback_source: 'trending' as const,
      })
    } catch {
      return NextResponse.json(
        { cards: [], next_cursor: null, no_more: true, error: '服务器暂时不可用' },
        { status: 200 } // 仍返回 200，前端显示空态
      )
    }
  }
}
