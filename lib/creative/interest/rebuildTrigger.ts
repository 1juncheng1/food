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
  FIRST_BUILD_MIN_EVENTS,
  REBUILD_HIGH_SIGNAL_MIN,
  REBUILD_HIGH_SIGNAL_TYPES,
  REBUILD_SEED_EVENT_TYPES,
  REBUILD_FRESH_TOPIC_LIMIT,
  REBUILD_SCAN_EVENT_LIMIT,
} from './config'
import { cleanTopicExcerpt } from './normalize'
import { getLastBuild } from './interestRepo'

/** 判定结论的原因码（可观测：写进日志与响应，便于定位"为什么又重建了"） */
export type RebuildReason = 'none' | 'first_build' | 'stale' | 'work_signal' | 'dirty'

export interface RebuildInput {
  hasProfile: boolean
  /** 画像 jsonb 的 updated_at（ISO）；无画像传 null */
  profileUpdatedAt: string | null
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

  // 2) 作品级高信号：1 条即触发（本模块存在的主要理由）
  if (input.highSignalCount >= REBUILD_HIGH_SIGNAL_MIN) {
    return { needed: true, reason: 'work_signal', workSignal: true }
  }

  // 3) 画像过期
  if (input.profileUpdatedAt) {
    const ts = Date.parse(input.profileUpdatedAt)
    if (Number.isFinite(ts)) {
      const ageHours = (input.now - ts) / 3_600_000
      if (ageHours > BUILD_MAX_AGE_HOURS) {
        return { needed: true, reason: 'stale', workSignal: false }
      }
    }
  }

  // 4) 一般行为累积到阈值（比等 1h 过期更及时）
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
  let dirtyCount = 0
  let highSignalCount = 0
  const freshWorkTopics: string[] = []

  for (const r of rows) {
    const type = typeof r.event_type === 'string' ? r.event_type : ''
    if (!type) continue
    dirtyCount += 1
    if (HIGH_SIGNAL_SET.has(type)) highSignalCount += 1
    if (SEED_EVENT_SET.has(type)) {
      const payload = (r.payload ?? {}) as Record<string, unknown>
      const topic = cleanTopicExcerpt(payload.topic_excerpt)
      if (topic && !freshWorkTopics.includes(topic)) freshWorkTopics.push(topic)
    }
  }

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
  opts: { hasProfile: boolean; profileUpdatedAt: string | null }
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
