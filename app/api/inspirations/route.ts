// ============================================================
// GET /api/inspirations —— 推荐重写（M4）
//
// 替换旧的 category 计票 + 手写模板路径。
// 新逻辑：读 active 推荐卡队列 → 分槽配额 → 确定性微调排序。
// 队列空/画像空 → 冷启动模板降级（诚实标注，不伪装个性化）。
// 响应契约增量扩展旧字段全保留，旧客户端不改也能跑。
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { rateLimit, getClientIp } from '@/lib/rateLimit'
import { getActiveSuggestions } from '@/lib/creative/interest/suggestionRepo'
import { getProfile } from '@/lib/creative/interest/interestRepo'
import { getFallbackInspirations } from '@/lib/creative/interest/fallbackTemplates'
import { selectSlots } from '@/lib/creative/interest/ranking'
import { runBuild } from '@/lib/creative/interest/builder'
import { BUILD_MAX_AGE_HOURS } from '@/lib/creative/interest/config'
import { findRunningBuild } from '@/lib/creative/interest/interestRepo'
import { evaluateRebuild } from '@/lib/creative/interest/rebuildTrigger'
import { refillSuggestions } from '@/lib/creative/interest/refill'
import { resolveDegradeReason, type DegradeReason } from '@/lib/creative/interest/degrade'
import { buildReasonText } from '@/lib/creative/interest/reasonAi'
import { getGlobalTrending, ingestGlobalTrending } from '@/lib/ci/globalTrending'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

interface SuggestionRow {
  id: string
  cluster_code: string
  slot: string
  source: string
  title: string
  description: string
  topic: string
  form_hint: string | null
  score: number
  score_breakdown: Record<string, number> | null
  evidence: Record<string, unknown> | null
  market_refs: Record<string, unknown> | null
  // WF6：AI 预制理由（旧卡为 null）
  core_question?: string | null
  why_recommend?: string | null
  creation_angle?: string | null
  related_knowledge?: string[] | null
  reason_source?: string | null
}

/**
 * 行为E：降级卡「为什么适合你」文案诚实化。
 * 旧版所有降级原因统一显示「大众创作方向」，在该栏目里答非所问且掩盖系统状态；
 * 按降级原因给用户明确预期（登录引导 / 第一篇创作后即定制 / 暂时不可用）。
 * 卡片角标仍由前端固定显示「大众创作方向」（内容性质标注，与此文案不冲突）。
 */
const FALLBACK_REASON_COPY: Record<DegradeReason, string> = {
  guest: '登录后，AI 会根据你的创作偏好为你推荐选题',
  auth_expired: '登录状态已过期，重新登录后恢复你的个性化推荐',
  cold_start: '还在了解你的创作偏好，完成第一篇创作后，这里会出现为你定制的选题',
  empty_queue: '还在学习你的创作方向，先看看这些热门选题',
  error: '暂时无法获取个性化推荐，先看看热门选题',
}

/**
 * 构造降级响应：优先当日真实全局热点（P1，仅 guest/cold_start 两个冷启动场景消费），
 * 不足/其他原因 → 静态模板卡 + 机器可读原因码（WF0）。
 * fallback_source 供前端区分"真实大众热点"与手写模板（WF10 的诚实口径延续）。
 */
async function fallbackResponse(reason: DegradeReason, building = false, stale = false) {
  let picks: Array<{ title: string; description: string; category: string }> = getFallbackInspirations(3)
  let fallbackSource: 'trending' | 'mixed' | 'template' = 'template'

  // empty_queue（有画像但队列空）/auth_expired/error 不混入大众热点流：
  // 有画像用户等重建更合理；失效会话不应触发全局搜索成本。
  if (reason === 'guest' || reason === 'cold_start') {
    const trending = await getGlobalTrending(3)
    if (trending.length >= 3) {
      // 当日热点充足：整组真实热点
      picks = trending
      fallbackSource = 'trending'
    } else if (trending.length > 0) {
      // 热点不足 3 张（首轮摄取进行中/部分类别失败）：热点优先，模板补齐
      const usedTitles = new Set(trending.map((t) => t.title))
      const fill = getFallbackInspirations(3).filter((t) => !usedTitles.has(t.title))
      picks = [...trending, ...fill].slice(0, 3)
      fallbackSource = 'mixed'
    }
  }

  return NextResponse.json({
    personalized: false,
    stale,
    building,
    fallback_source: fallbackSource,
    degrade_reason: reason,
    inspirations: picks.map((p) => ({
      title: p.title,
      description: p.description,
      reason: FALLBACK_REASON_COPY[reason],
      params: { category: p.category, topic: p.title },
    })),
  })
}

const RATE_LIMIT_PER_MIN = 30
const RATE_WINDOW_MS = 60_000

export async function GET(req: Request) {
  try {
    // ── 限流：按客户端 IP（未登录路径无任何身份维度可用）──
    // 本路由会 fire-and-forget 触发 runBuild（多次 LLM）与全局热点摄取（付费搜索），
    // 无 IP 限流时匿名循环即可放大外部 API 成本。
    const ipRl = rateLimit(`inspirations:${getClientIp(req)}`, RATE_LIMIT_PER_MIN, RATE_WINDOW_MS)
    if (!ipRl.ok) {
      return NextResponse.json(
        { error: `请求过于频繁，请 ${ipRl.retryAfterSec} 秒后再试` },
        { status: 429, headers: { 'Retry-After': String(ipRl.retryAfterSec) } }
      )
    }

    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) {
      // 游客模式已下线：功能页全部需登录，登录入口统一在首页。
      // 这里必须硬 401，而不是"返回几张模板卡将就一下"——给未登录用户一个 200，
      // 等于告诉他"这功能你能用"，而这条链路后面就是付费的热点摄取与多次 LLM build。
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }

    const supabase = createServerClient(token)
    const { data: userData, error: authErr } = await supabase.auth.getUser()
    if (authErr || !userData.user) {
      // token 失效/过期：与游客同样展示模板，但原因码区分，便于统计僵尸会话比例。
      // 不触发全局摄取（无效会话不应放大搜索成本）。
      return await fallbackResponse('auth_expired')
    }
    const userId = userData.user.id

    // 行为C：是否有在途 build（fire-and-forget 重建中）。
    // 前端据此显示「正在分析你的第一篇作品…」，配合既有 20s 轮询在 build 完成后自动换卡。
    const building = !!(await findRunningBuild(supabase, userId))

    // ── 读画像（判断是否冷启动） ──
    const { profile } = await getProfile(supabase, userId)
    const hasProfile = profile && Object.keys(profile).length > 0 && (profile as Record<string, unknown>).build_id

    // ── 自动触发重建（fire-and-forget：本次仍返回当前可用结果，重建下次进页生效）──
    //
    // 判定逻辑已收敛到 rebuildTrigger（与 Feed 端点同源），此处只负责选择动作。
    // 关键增量：作品级行为（新增/删除/定稿/采纳）走低阈值通道——1 篇作品只产生
    // 1~3 条事件，旧的"脏事件 ≥5"永远够不着，用户创作完回来看到的还是旧卡。
    const rawUpdatedAt = (profile as Record<string, unknown> | null)?.updated_at
    const profileUpdatedAt: string | null = typeof rawUpdatedAt === 'string' ? rawUpdatedAt : null
    const stale = profileUpdatedAt
      ? (Date.now() - Date.parse(profileUpdatedAt)) / 3_600_000 > BUILD_MAX_AGE_HOURS
      : false

    // hasProfile 由 && 链推出，类型是 truthy 联合而非 boolean，此处显式收敛
    const rebuild = await evaluateRebuild(supabase, userId, {
      hasProfile: !!hasProfile,
      profileUpdatedAt,
    })
    if (!building && rebuild.needed) {
      if (rebuild.workSignal) {
        // 作品级信号：走轻量补货，不清空队列。dashboard 一次只展示 3 张卡，
        // 若这里 supersede 清空队列，用户会看到"卡片突然全换/变少"的跳变；
        // 追加新卡则自然得多，且与 Feed 端点同口径。
        void refillSuggestions(supabase, userId, {
          freshWorkTopics: rebuild.freshWorkTopics,
        }).catch(() => {})
      } else {
        // 首建 / 画像过期 / 一般行为累积：完整重建（本端点队列小，supersede 代价可控）
        void runBuild(supabase, userId, rebuild.reason === 'first_build' ? 'full' : 'incremental').catch(
          () => {}
        )
      }
    }

    // ── 读 active 推荐卡 ──
    const suggestions = await getActiveSuggestions(supabase, userId, 6)

    // ── 冷启动 / 队列空 → 降级（两种原因严格区分，便于可观测） ──
    if (!hasProfile) {
      // 无画像登录用户同享当日真实热点；懒触发摄取（fire-and-forget）
      void ingestGlobalTrending().catch(() => {})
      return await fallbackResponse('cold_start', building, stale)
    }
    if (!suggestions.length) {
      return await fallbackResponse('empty_queue', building, stale)
    }

    // ── 分槽配额：从 active 卡中选 3 张 ──
    const rows = suggestions as unknown as SuggestionRow[]
    const selected = selectSlots(
      rows.map((r) => ({
        id: r.id,
        clusterCode: r.cluster_code,
        slot: r.slot as 'core_gap' | 'evidence_followup' | 'exploration' | 'continuation',
        score: r.score,
        title: r.title,
        description: r.description,
        topic: r.topic,
        formHint: r.form_hint ?? '其他',
        scoreBreakdown: r.score_breakdown ?? {},
        evidence: r.evidence ?? {},
        marketFlags: r.market_refs ?? {},
        coreQuestion: r.core_question ?? null,
        whyRecommend: r.why_recommend ?? null,
        creationAngle: r.creation_angle ?? null,
        relatedKnowledge: r.related_knowledge ?? [],
        reasonSource: r.reason_source ?? 'template',
      })),
      {
        maxCoreWeight: (() => {
          const coreArr = (profile as Record<string, unknown>)?.core as
            | Array<Record<string, unknown>>
            | undefined
          const w = coreArr?.[0]?.weight
          return typeof w === 'number' ? w : 0
        })(),
      }
    )

    return NextResponse.json({
      personalized: true,
      stale,
      building,
      inspirations: selected.map((s) => ({
        rec_id: s.id,
        title: s.title,
        description: s.description,
        reason: buildReasonText(s),
        // WF6：AI 预制理由（build 时生成落库；旧卡/模板卡为 null，前端回退 reason）
        core_question: s.coreQuestion,
        why_recommend: s.whyRecommend,
        creation_angle: s.creationAngle,
        related_knowledge: s.relatedKnowledge,
        reason_source: s.reasonSource,
        params: {
          category: s.formHint,
          topic: s.topic,
          rec_id: s.id,
        },
        slot: s.slot,
        cluster_code: s.clusterCode,
        score_breakdown: s.scoreBreakdown,
        evidence: s.evidence,
        market_flags: s.marketFlags,
      })),
    })
  } catch (error) {
    // WF0：任何未预期异常都带 error 原因码，且日志保留原始 message——
    // 旧版 catch-all 静默吞错是 D2（权限/表故障被伪装成普通模板推荐）的放大器。
    console.error('inspirations API 错误:', error instanceof Error ? error.message : error)
    return await fallbackResponse('error')
  }
}
