// ============================================================
// Creator Interest Profile —— 重建触发判定（P0：数据闭环）
//
// 为什么单独成模块：
//   「什么时候该重算画像 / 补卡」的判定此前只存在于 /api/inspirations 的内联代码里，
//   而用户真正长时间停留的 Feed 端点完全没有重建判定（它只有「库存 ≤8」这一个
//   补货触发点）。两处都要随业务演进加规则，散落必然漂移，所以收敛为：
//     纯函数 decideRebuild（可单测、无 IO）+ 取数入口 evaluateRebuild（路由唯一调用）
//
// 核心口径：作品级行为走独立低阈值通道（1 条即触发）。
//   一篇作品只产生 1~3 条事件（work_generate，定稿时可能再加 work_finalize），
//   而旧阈值是「脏事件 ≥5」——日常创作永远够不着，画像 1h 过期又是远水救不了近火。
//   这就是「新增/删除作品后推荐没变化」的直接根因之一。
//
// 红线：本模块只回答「要不要重算」，不触发任何写操作、不做评分、不碰画像内容。
//   触发后的动作（refill / runBuild）由路由决定——Feed 与 dashboard 的代价不同：
//   Feed 不能 supersede 队列（会让正在翻的游标失效），dashboard 可以。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BUILD_DIRTY_EVENT_COUNT,
  BUILD_MAX_AGE_HOURS,
  EVENT_REGISTRY,
  FIRST_BUILD_MIN_EVENTS,
  REBUILD_HIGH_SIGNAL_MIN,
  REBUILD_HIGH_SIGNAL_TYPES,
  REBUILD_SEED_EVENT_TYPES,
  REBUILD_FRESH_TOPIC_LIMIT,
  REBUILD_SCAN_EVENT_LIMIT,
  RULE_VERSION,
} from './config'
import { cleanTopicExcerpt } from './normalize'
import { getLastBuild } from './interestRepo'
import type { CreatorEventType } from './types'

/** 判定结论的原因码（可观测：写进日志与响应，便于定位"为什么又重建了"） */
export type RebuildReason =
  | 'none'
  | 'first_build'
  | 'rule_upgrade'
  | 'stale'
  | 'work_signal'
  | 'dirty'

export interface RebuildInput {
  hasProfile: boolean
  /** 画像 jsonb 的 updated_at（ISO）；无画像传 null */
  profileUpdatedAt: string | null
  /**
   * 画像生成时的规则版本；无画像传 null。
   *
   * 取值来自 `style_profiles.interest_profile` 这个 **jsonb 列**的 `rule_version`
   * 字段。没有独立叫 `interest_profile` 的表——按表名去找会查不到，然后误判成
   * "画像没落库"（实测踩过：用 service_role 查 interest_profile 表返回
   * PGRST205，但画像其实一直在 style_profiles 里）。
   *
   * null 也会判为过期：那表示画像早于版本化之前生成，一定不是当前口径。
   */
  profileRuleVersion: string | null
  /** 自上次 build 已消费事件点以来的事件总数 */
  dirtyCount: number
  /** 自上次 build 已消费事件点以来的作品级高信号事件数 */
  highSignalCount: number
  /** 用户事件总数（仅无画像时的首建判定用） */
  totalEvents: number
  /** 注入的当前时间戳（便于测试） */
  now: number
}

export interface RebuildVerdict {
  needed: boolean
  reason: RebuildReason
  /** 是否由作品级行为驱动（决定要不要用新作品主题做补货种子） */
  workSignal: boolean
}

const HIGH_SIGNAL_SET: ReadonlySet<string> = new Set<string>(REBUILD_HIGH_SIGNAL_TYPES)
const SEED_EVENT_SET: ReadonlySet<string> = new Set<string>(REBUILD_SEED_EVENT_TYPES)

/**
 * 纯函数：给定信号计数，判定是否需要重建。
 *
 * 判定顺序即优先级——作品级信号优先于 stale，这样即使用户画像正好过期，
 * 日志里看到的也是更具体的 work_signal，便于归因。
 */
export function decideRebuild(input: RebuildInput): RebuildVerdict {
  const none: RebuildVerdict = { needed: false, reason: 'none', workSignal: false }

  // 1) 无画像：只有攒够行为事件才值得首建，否则建出来也是噪声画像
  if (!input.hasProfile) {
    return input.totalEvents >= FIRST_BUILD_MIN_EVENTS
      ? { needed: true, reason: 'first_build', workSignal: false }
      : none
  }

  // 2) 规则版本过期：评分公式变了，必须整体重建（优先级高于一切行为信号）。
  //
  // 为什么压过 work_signal：那条路只走 refill，而 refill 是**追加**新卡。旧卡按旧公式（interestMatch 0.4）
  //   记分、新卡按新公式（0.16 + recency/knowledge 独立成维）记分，同一队列按一个
  //   score 排序 = 两把尺子混排。继续补货只会让混排更深。
  // 生产实锤：某用户 49 张 active 卡里 25 张 v2 口径 + 24 张 v3 口径；另两个用户的
  // profile.rule_version 停在 interest-rules-v2，而代码已是 v4——在此之前没有任何
  // 一处比较这两个值，谁都不知道画像过期了，评分公式升级等于没上线。
  //
  // 自终止：重建完成后画像被人打上当前 RULE_VERSION，判定不再命中，不会反复重建。
  if (input.profileRuleVersion !== RULE_VERSION) {
    return { needed: true, reason: 'rule_upgrade', workSignal: false }
  }

  // 3) 作品级高信号：1 条即触发（本模块存在的主要理由）
  if (input.highSignalCount >= REBUILD_HIGH_SIGNAL_MIN) {
    return { needed: true, reason: 'work_signal', workSignal: true }
  }

  // 4) 画像过期
  if (input.profileUpdatedAt) {
    const ts = Date.parse(input.profileUpdatedAt)
    if (Number.isFinite(ts)) {
      const ageHours = (input.now - ts) / 3_600_000
      if (ageHours > BUILD_MAX_AGE_HOURS) {
        return { needed: true, reason: 'stale', workSignal: false }
      }
    }
  }

  // 5) 一般行为累积到阈值（比等 1h 过期更及时）
  if (input.dirtyCount >= BUILD_DIRTY_EVENT_COUNT) {
    return { needed: true, reason: 'dirty', workSignal: false }
  }

  return none
}

// ── 取数 ──

/**
 * 上次 build 已消费到的事件时间。
 *
 * 增量 build 已改为全窗口确定性重算，但"哪些事件是上次 build 之后新增的"
 * 仍需一个分界点：interest_builds.event_range.to_event_id → 该事件的 occurred_at。
 * 拿不到（从未成功 build / 事件行已被删）时返回 null，调用方按"全部视为新增"处理。
 */
async function resolveLastBuildEventTime(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const lastBuild = await getLastBuild(supabase, userId)
  const toEventId = (lastBuild?.event_range as { to_event_id?: string } | null)?.to_event_id
  if (!toEventId) return null
  const { data } = await supabase
    .from('creator_events')
    .select('occurred_at')
    .eq('id', toEventId)
    .maybeSingle()
  return typeof data?.occurred_at === 'string' ? data.occurred_at : null
}

interface RebuildSignals {
  totalEvents: number
  dirtyCount: number
  highSignalCount: number
  freshWorkTopics: string[]
}

/**
 * 纯函数：从事件行统计重建判定信号（抽出来是为了能单测曝光过滤这条规则）。
 *
 * dirtyCount 的口径：只数"用户的表达"，不数"系统的动作"。
 *
 * 曝光（recommend_impression，effect=stats_only、weight=0）绝不计入——
 * 它是系统把卡推到用户面前这个动作本身，不是用户点了什么。
 * 生产实锤：此前它对 dirtyCount 照 +1 不误，于是
 *   刷满 5 张卡 = 5 条脏事件 = 命中 BUILD_DIRTY_EVENT_COUNT
 *   → 触发 runBuild（全窗口重算聚类 + 3 次 LLM，20-150s）
 * 于是"看"这个动作竟然能驱动最贵的一次计算：刷得越多，重建越频繁。
 * 代价是 LLM 成本与后台负载（以及 in-flight build 长期占用，前端一直显示
 * "分析中"），而不是队列被清空——队列是原子切换的，见 suggestionRepo。
 *
 * 未知事件类型（不在 EVENT_REGISTRY 里）保守计入，保持与改动前一致，
 * 避免新增事件类型时静默失去触发能力。
 */
export function countRebuildSignals(
  rows: Array<{ event_type?: unknown; payload?: unknown }>
): Omit<RebuildSignals, 'totalEvents'> {
  let dirtyCount = 0
  let highSignalCount = 0
  const freshWorkTopics: string[] = []

  for (const r of rows) {
    const type = typeof r.event_type === 'string' ? r.event_type : ''
    if (!type) continue
    const entry = EVENT_REGISTRY[type as CreatorEventType]
    if (entry?.effect === 'stats_only') continue
    dirtyCount += 1
    if (HIGH_SIGNAL_SET.has(type)) highSignalCount += 1
    if (SEED_EVENT_SET.has(type)) {
      const payload = (r.payload ?? {}) as Record<string, unknown>
      const topic = cleanTopicExcerpt(payload.topic_excerpt)
      if (topic && !freshWorkTopics.includes(topic)) freshWorkTopics.push(topic)
    }
  }

  return { dirtyCount, highSignalCount, freshWorkTopics }
}

/**
 * 一次并行取数拿到全部判定信号。
 *
 * 只取「最新的 REBUILD_SCAN_EVENT_LIMIT 条」而非全表：判定只需要"最近有没有新东西"，
 * 倒序取最新一批即可（正序 limit 会拿到最老的 N 条，新增事件反被截断——
 * fetchEvents 踩过完全相同的坑）。
 */
async function loadRebuildSignals(
  supabase: SupabaseClient,
  userId: string,
  sinceIso: string | null
): Promise<RebuildSignals> {
  const [totalRes, recentRes] = await Promise.all([
    supabase
      .from('creator_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId),
    supabase
      .from('creator_events')
      .select('event_type, payload')
      .eq('user_id', userId)
      // 无分界点（从未成功 build）时从纪元起算：全部事件都算"上次 build 之后新增"
      .gt('occurred_at', sinceIso ?? '1970-01-01T00:00:00.000Z')
      .order('occurred_at', { ascending: false })
      .limit(REBUILD_SCAN_EVENT_LIMIT),
  ])

  const rows = (recentRes.data ?? []) as Array<{ event_type?: unknown; payload?: unknown }>
  const { dirtyCount, highSignalCount, freshWorkTopics } = countRebuildSignals(rows)

  return {
    totalEvents: totalRes.count ?? 0,
    dirtyCount,
    highSignalCount,
    freshWorkTopics: freshWorkTopics.slice(0, REBUILD_FRESH_TOPIC_LIMIT),
  }
}

export interface RebuildAssessment extends RebuildVerdict {
  /** 上次 build 已消费到的事件时间；null = 从未成功 build */
  sinceIso: string | null
  /** 自该时间点以来的新作品主题（供 refill 做种子，仅正向作品行为） */
  freshWorkTopics: string[]
}

/**
 * 路由唯一入口：取数 + 判定。
 *
 * 全程吞错——判定失败最坏结果是"本次不重建"，用户看到旧卡，
 * 远好过把 Feed 请求打成 500。
 */
export async function evaluateRebuild(
  supabase: SupabaseClient,
  userId: string,
  opts: { hasProfile: boolean; profileUpdatedAt: string | null; profileRuleVersion: string | null }
): Promise<RebuildAssessment> {
  const fallback: RebuildAssessment = {
    needed: false,
    reason: 'none',
    workSignal: false,
    sinceIso: null,
    freshWorkTopics: [],
  }
  try {
    const sinceIso = await resolveLastBuildEventTime(supabase, userId)
    const signals = await loadRebuildSignals(supabase, userId, sinceIso)
    const verdict = decideRebuild({
      hasProfile: opts.hasProfile,
      profileUpdatedAt: opts.profileUpdatedAt,
      profileRuleVersion: opts.profileRuleVersion,
      dirtyCount: signals.dirtyCount,
      highSignalCount: signals.highSignalCount,
      totalEvents: signals.totalEvents,
      now: Date.now(),
    })
    return { ...verdict, sinceIso, freshWorkTopics: signals.freshWorkTopics }
  } catch (e) {
    console.error('[interest] 重建判定失败:', e instanceof Error ? e.message : e)
    return fallback
  }
}
