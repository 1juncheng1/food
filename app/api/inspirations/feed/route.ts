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
import { authFailureResponse } from '@/lib/apiAuth'
import { getProfile, findRunningBuild, fetchActiveClusters } from '@/lib/creative/interest/interestRepo'
import { buildReasonText } from '@/lib/creative/interest/reasonAi'
import {
  getGlobalTrending,
  ingestGlobalTrending,
  getPersonalizedTrending,
  type GlobalTrendingCard,
} from '@/lib/ci/globalTrending'
import { refillSuggestions, topUpQueue } from '@/lib/creative/interest/refill'
import { evaluateRebuild } from '@/lib/creative/interest/rebuildTrigger'
import { runBuild } from '@/lib/creative/interest/builder'
import { FEED_TRENDING_INJECT_MAX, FEED_FRESH_INJECT_MAX } from '@/lib/creative/interest/config'
import {
  getFeedPage,
  getDailySuggestionCount,
  getDailyServedCount,
  loadFreshSuggestions,
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
  // P0 闭环：本轮新作品驱动生成的卡（首屏前置，供前端打「承接你的新作品」标）
  fresh?: boolean
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

/**
 * 取用户核心兴趣向量：core 簇中权重最高者的质心，退化到任一有质心的簇。
 *
 * 只在热点补位时调用（缺卡才发生，低频路径），且全程吞错——拿不到向量
 * 只让补位退回"全网热点"，不影响 Feed 主流程。
 */
async function loadCoreInterestVector(
  supabase: Parameters<typeof fetchActiveClusters>[0],
  userId: string
): Promise<number[] | null> {
  try {
    const rows = await fetchActiveClusters(supabase, userId)
    const withCentroid = rows.filter(
      (r) => Array.isArray(r.centroid) && (r.centroid as unknown[]).length === 1024
    )
    if (!withCentroid.length) return null
    // fetchActiveClusters 已按 weight DESC 排序，core 取首条即可
    const core = withCentroid.find((r) => r.layer === 'core')
    return (core ?? withCentroid[0]).centroid as number[]
  } catch (e) {
    console.warn('[feed] 核心兴趣向量读取失败:', e instanceof Error ? e.message : String(e))
    return null
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
      // 网络抖动时返回 503 而非 401：前端据此不得把用户踢到登录页
      return authFailureResponse(authErr)
    }
    const userId = userData.user.id

    // ── 解析查询参数 ──
    const url = new URL(req.url)
    const cursor = url.searchParams.get('cursor') ?? undefined
    const limitParam = url.searchParams.get('limit')
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 10, 1), 50) : 10

    // ── 并行启动：日出卡计数 + 生成量观测 + 画像读取 ──
    // 三个查询无依赖关系，串行实现浪费 ~150-300ms
    const [servedCount, generatedToday, profileRes] = await Promise.all([
      getDailyServedCount(supabase, userId),
      getDailySuggestionCount(supabase, userId),
      getProfile(supabase, userId),
    ])
    const dailyCount = servedCount

    // ── 日出卡上限检查（AC-6）──
    // 口径 = 用户当日实际看到的卡数（impression 去重），而非系统生成量：
    // 用生成量会在补货频繁时让用户没翻几页就撞上 100 上限 → no_more，
    // 反而制造"刷到哪就没了"。
    if (dailyCount >= FEED_DAILY_CAP) {
      return NextResponse.json({
        cards: [],
        next_cursor: null,
        no_more: true,
        daily_count: dailyCount,
        generated_today: generatedToday,
        fallback_source: null,
      })
    }

    // ── 读画像（判断是否冷启动） ──
    const { profile } = profileRes
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
        generated_today: generatedToday,
        fallback_source: 'trending' as const,
        building: false,
      })
    }

    // ── P0 数据闭环：统一的重建/补货判定 ──
    //
    // 此前 Feed 端点只有「库存 ≤8」这一个补货触发点，作品新增/删除（1~3 条事件）
    // 永远够不着 /api/inspirations 的脏事件阈值 5——用户在 Feed 里刷再久，
    // 推荐也纹丝不动。这里复用与 dashboard 同源的判定，并给作品级行为开低阈值通道。
    //
    // Feed 红线：除"无画像首建"外，这里绝不直接 runBuild。runBuild 第一步
    // supersedeOldBuild 会清空 active 队列，用户正在翻的游标当场失效，
    // 重建的 20-150s 里翻页只能撞到降级热点（"刷到哪就没了"的已知根因）。
    let building = !!(await findRunningBuild(supabase, userId))
    const rebuild = await evaluateRebuild(supabase, userId, {
      // hasProfile 由 && 链推出，类型是 truthy 联合而非 boolean，此处显式收敛
      hasProfile: !!hasProfile,
      profileUpdatedAt:
        typeof (profile as Record<string, unknown> | null)?.updated_at === 'string'
          ? ((profile as Record<string, unknown>).updated_at as string)
          : null,
    })

    if (!building && rebuild.needed) {
      if (rebuild.reason === 'first_build') {
        // 无画像 = 没有队列可清，完整 build 是唯一出路
        void runBuild(supabase, userId, 'full').catch(() => {})
        building = true
      } else {
        // 同步 await 而非 fire-and-forget：让"刚写完一篇"这件事在本请求内就产出新卡，
        // 用户这一次刷新就能看到变化，而不是依赖后台任务跑完（serverless 可能冻结）。
        // 成本由 refill 自身的 5 分钟最小间隔 + 在途锁兜底，不会随刷新频率放大。
        const r = await refillSuggestions(supabase, userId, {
          freshWorkTopics: rebuild.workSignal ? rebuild.freshWorkTopics : [],
        })
        // refill 不可行（从未成功 build / 无活跃簇 / 失败）→ 回退既有补货入口
        if (r.reason === 'no_build' || r.reason === 'no_cluster' || r.reason === 'failed') {
          void topUpQueue(supabase, userId).catch(() => {})
          building = true
        }
      }
    }

    // ── 读 Feed 页 ──
    const page = await getFeedPage(supabase, userId, { cursor, limit })

    // ── 本轮新卡前置（仅首屏）──
    // 补货往队尾追加 + 首页按 score 取前 N 张 = 新卡掉出首屏，闭环在体感上等于没发生。
    // 首屏前置这几张，翻页仍走原游标（getFeedPage 全量排序不受影响）。
    let freshRows: SuggestionRow[] = []
    if (!cursor && rebuild.sinceIso) {
      freshRows = await loadFreshSuggestions(
        supabase,
        userId,
        rebuild.sinceIso,
        FEED_FRESH_INJECT_MAX
      )
    }
    const freshIds = new Set(freshRows.map((r) => r.id))

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
        no_more: false, // 画像在，补货完成后会有新卡
        daily_count: dailyCount,
        generated_today: generatedToday,
        fallback_source: 'trending' as const,
        building,
      })
    }

    // ── 补卡触发：库存 ≤ 阈值 且日未达上限且无在途 build → fire-and-forget ──
    // building 已在上面的重建判定里取过，此处复用，不再重复查一次在途 build
    if (!building && page.remaining <= FEED_TOPUP_THRESHOLD && dailyCount + limit < FEED_DAILY_CAP) {
      // 轻量 refill 优先：复用上次簇只造卡，不清空队列、秒级完成，用户翻页不中断。
      // 旧实现直接 runBuild，而 runBuild 第一步就 supersede 清空队列 —— 用户正在
      // 翻的游标当场失效，重建的 20-150s 里翻页只能撞到降级热点（"刷到哪就没了"根因）。
      // topUpQueue 内部在 refill 不可行时才回退 runBuild。
      void topUpQueue(supabase, userId).catch(() => {})
    }

    // ── 热点补位：个性化卡不足一页时，用当日全网热点补齐短板 ──
    // 只在缺额处补，绝不挤占个性化卡；热点卡 reason 明确写"当下全网热门"，
    // 不套用"因为你喜欢 X"的个性化文案（WF10 诚实口径延续）。
    const cards = [
      ...freshRows.map((r) => ({ ...mapSuggestionToCard(r), fresh: true })),
      ...page.cards.filter((r) => !freshIds.has(r.id)).map(mapSuggestionToCard),
    ]
    if (cards.length < limit) {
      const need = Math.min(limit - cards.length, FEED_TRENDING_INJECT_MAX)
      // 「兴趣 × 热点」交叉：先用 core 兴趣向量在当日热点池里召回最相关的方向；
      // 召回为空（无向量 / 当日未摄取 / 全池低于相似度阈值）才回退"全网热点按时间倒序"。
      const interestVector = await loadCoreInterestVector(supabase, userId)
      let trending: GlobalTrendingCard[] = []
      if (interestVector) {
        trending = await getPersonalizedTrending(interestVector, need + 2)
      }
      // 多取几张：按标题去重后仍要凑够 need
      if (!trending.length) {
        trending = await getGlobalTrending(need + 2)
      }
      // 当日尚无热点数据 → 懒触发一次摄取（fire-and-forget）。
      // 缺口说明：旧设计只让 /api/inspirations 的冷启动分支触发 ingestGlobalTrending，
      // 而有画像的活跃用户永远不会走那个分支，导致当日热点可能从未摄取、
      // Feed 补位永远为空。沿用同一套成本闸门（日 hash 幂等 + 进程内在途锁 +
      // GLOBAL_TRENDING_FRESH_MIN 计数闸门），且只在"确实缺卡"时才触发，
      // 频率远低于冷启动路径。
      if (!trending.length) {
        void ingestGlobalTrending().catch(() => {})
      }
      const used = new Set(cards.map((c) => c.title))
      let injected = 0
      for (const t of trending) {
        if (injected >= need) break
        if (used.has(t.title)) continue
        cards.push({
          rec_id: `trending-${t.title}`,
          title: t.title,
          description: t.description,
          // 诚实口径：交叉召回的卡说"与你关注方向相近"，兜底卡说"当下全网热门"，
          // 两者都不伪装成"因为你喜欢 X"（WF10 诚实文案红线延续）
          reason: 'similarity' in t ? '与你关注方向相近的当下热点' : '当下全网热门创作方向',
          topic: t.title,
          params: { category: t.category, topic: t.title, rec_id: `trending-${t.title}` },
          slot: 'exploration',
          cluster_code: 'global_trending',
          score: 0,
          score_breakdown: {},
          evidence: { source: 'global_trending' },
          reason_source: 'template',
          cross_exploration: false,
        })
        used.add(t.title)
        injected++
      }
    }

    // ── 正常返回 ──
    return NextResponse.json({
      cards,
      next_cursor: page.next_cursor,
      no_more: page.next_cursor === null && page.remaining <= FEED_TOPUP_THRESHOLD,
      daily_count: dailyCount,
      generated_today: generatedToday,
      fallback_source: null,
      building,
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
