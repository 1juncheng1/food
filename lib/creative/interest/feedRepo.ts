// ============================================================
// WF11 P2：Feed 游标分页纯读层
//
// interest_suggestions 表的 Feed 专用读取接口：
//   - 按 score DESC + id ASC 稳定排序（与 selectSlots 的 stableOrder 同方向）
//   - 排除当日已 dismiss / 已曝光的卡（保证翻页无重复无遗漏，AC-4）
//   - 游标编码/解码（无状态 token，不落库）
//   - 日出卡上限 100 张（AC-6）
//
// 纯读路径，不触发 build/LLM；补卡触发由 route 层判断后 fire-and-forget。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  SUGGESTION_BASE_COLUMNS,
  SUGGESTION_RERANK_COLUMNS,
  rerankColumnsMissing,
  type SuggestionRow,
} from './suggestionRepo'
import { applyRescore, type RescoreContext } from './rescore'

/** 每用户每日出卡上限（spec AC-6，达上限返回 no_more 且不产生新 LLM 调用） */
export const FEED_DAILY_CAP = 100

/** 默认每页数量 */
export const FEED_PAGE_SIZE = 10

/** 补卡触发阈值：剩余 active 库存低于此值时 fire-and-forget 触发增量 build */
export const FEED_TOPUP_THRESHOLD = 8

/** 每 10 张卡中 exploration 槽位的最低数量（spec AC-10） */
export const EXPLORE_QUOTA_PER_10 = 2

// ── 游标编码/解码 ──

/**
 * 游标 = base64url(JSON { s: score, i: id })。
 * 使用 Buffer 而非 btoa，兼容 Node.js 运行时。
 * 无状态 token，不落库，客户端透传。
 */
export function encodeCursor(score: number, id: string): string {
  return Buffer.from(JSON.stringify({ s: score, i: id }), 'utf-8').toString('base64url')
}

export function decodeCursor(cursor: string): { s: number; i: string } | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf-8')
    const parsed = JSON.parse(json) as { s?: number; i?: string }
    if (typeof parsed.s !== 'number' || typeof parsed.i !== 'string') return null
    return { s: parsed.s, i: parsed.i }
  } catch {
    return null
  }
}

// ── 内部辅助 ──

/**
 * 查询当日（UTC 0 点起）已 dismiss 和已曝光的推荐卡 ID 集合。
 * - recommend_dismiss：用户点 ✕，永久离队
 * - recommend_impression：已展示给用户（按天幂等，同卡同天只一条）
 * 排除这些卡，保证 Feed 翻页不重复展示已看过或不感兴趣的卡（AC-4）。
 */
async function getTodayExcludedIds(
  supabase: SupabaseClient,
  userId: string
): Promise<Set<string>> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const { data, error } = await supabase
    .from('creator_events')
    .select('target_id')
    .eq('user_id', userId)
    // 列名必须是 event_type：creator_events 无 type 列，错列名会让 PostgREST 报错
    // 并走进上面的 error 分支静默返回空集合——结果是当日已看/已 ✕ 的卡从未被排除，
    // Feed 翻页反复出现同一批卡（"刷到哪就没了"的体感放大器）。
    .in('event_type', ['recommend_dismiss', 'recommend_impression'])
    .gte('occurred_at', todayStart.toISOString())
  if (error) {
    console.error('[feed] 查询当日排除 ID 失败:', error)
    return new Set()
  }
  return new Set(
    (data ?? [])
      .map((r) => r.target_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  )
}

// ── explore/exploit 配额（AC-10）──

/**
 * 每 10 张保证 ≥2 张 exploration 槽位卡（spec P3 AC-10）。
 *
 * 策略：按 slot 分桶（exploration vs 其他），两桶各自已按 score DESC 排好序。
 * 每 10 张窗口放 8 张 nonExploration + 2 张 exploration；
 * exploration 不足时全部放入，剩余位置用 nonExploration 补（不造水卡）。
 *
 * 返回重排后的完整列表，游标基于此最终顺序。
 */
export function applyExploreQuota<T extends { slot: string; score: number; id: string }>(
  rows: T[]
): T[] {
  if (rows.length === 0) return []

  const exploration = rows.filter((r) => r.slot === 'exploration')
  const nonExploration = rows.filter((r) => r.slot !== 'exploration')

  // 两桶各自已按 score DESC（DB 查询排序保证），直接按索引取
  const result: T[] = []
  let ei = 0 // exploration 指针
  let ni = 0 // nonExploration 指针

  while (ni < nonExploration.length || ei < exploration.length) {
    // 当前窗口位置（0-indexed in result）
    const posInWindow = result.length % 10

    // 每 10 张窗口的最后 EXPLORE_QUOTA_PER_10 个位置留给 exploration
    // 例如 EXPLORE_QUOTA_PER_10=2：窗口位置 8、9 优先取 exploration
    const isExploreSlot = posInWindow >= (10 - EXPLORE_QUOTA_PER_10)

    if (isExploreSlot && ei < exploration.length) {
      result.push(exploration[ei++])
    } else if (ni < nonExploration.length) {
      result.push(nonExploration[ni++])
    } else if (ei < exploration.length) {
      // nonExploration 耗尽，用 exploration 补位
      result.push(exploration[ei++])
    } else {
      break
    }
  }

  return result
}

// ── 读取接口 ──

/**
 * 读取 Feed 页。
 *
 * 策略：用户日上限 100 张，全量读取 active 卡后在 JS 层做排除和分页。
 * 这避免了 Supabase or/and 嵌套过滤的兼容性风险，且数据量小无性能问题。
 *
 * 排序：score DESC + id ASC（与 selectSlots 的 stableOrder 同方向，
 * 保证高分卡优先、同分卡稳定有序）。
 * P3 起：分页前先经 applyExploreQuota 重排，保证每 10 张 ≥2 张 exploration。
 *
 * 游标：{ s: last_score, i: last_id }，定位"上一页最后一条"，
 * 下一页从该条之后开始。
 *
 * 返回：
 *   cards       本页卡片
 *   next_cursor 下一页游标（null=已到末尾）
 *   no_more     仅在日上限达 100 时由 route 层置 true
 *   remaining   剩余未翻页的可用卡数（route 据此判断是否触发补卡）
 */
export async function getFeedPage(
  supabase: SupabaseClient,
  userId: string,
  opts: { cursor?: string; limit?: number; rescore?: RescoreContext | null } = {}
): Promise<{
  cards: SuggestionRow[]
  next_cursor: string | null
  no_more: boolean
  remaining: number
}> {
  const limit = Math.min(Math.max(opts.limit ?? FEED_PAGE_SIZE, 1), 50)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null

  const activeRows = (columns: string) =>
    supabase
      .from('interest_suggestions')
      .select(columns)
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('score', { ascending: false })
      .order('id', { ascending: true })

  // 1. 并行启动：当日已 dismiss/已曝光的卡 ID + 全部 active 推荐卡（P1-4 优化）
  // 两个查询无依赖关系，原串行实现浪费 ~100-200ms
  const [excludedIds, mainQueryRes] = await Promise.all([
    getTodayExcludedIds(supabase, userId),
    activeRows(SUGGESTION_RERANK_COLUMNS),
  ])

  // 2. 主查询结果处理；迁移 0018 未落地时退回基础列（库 score 排序）
  let { data, error } = mainQueryRes
  if (error && rerankColumnsMissing(error)) {
    const fallback = await activeRows(SUGGESTION_BASE_COLUMNS)
    data = fallback.data
    error = fallback.error
  }
  if (error) {
    console.error('[feed] 查询 Feed 页失败:', error)
    return { cards: [], next_cursor: null, no_more: false, remaining: 0 }
  }

  // 3. JS 层排除当日已 dismiss/已曝光的卡
  const excludedRows = ((data ?? []) as unknown as SuggestionRow[]).filter(
    (r) => !excludedIds.has(r.id)
  )

  // 4. RULE v5：用「当下的画像」重算分并重排（无上下文则保持库 score）
  const reranked = opts.rescore ? applyRescore(excludedRows, opts.rescore) : excludedRows

  // 5. P3 AC-10：applyExploreQuota 重排，保证每 10 张 ≥2 张 exploration
  const rows = applyExploreQuota(reranked)

  // 6. 游标定位：找到 cursor 指定的起始位置
  //
  // 只按 id 匹配，不再比对 score。库 score 与在线重排后的现场分是两个不同的值：
  // 只要把 score 卷进定位条件，任何一次重排（执行一次 ✕ 后的口味惩罚也算）
  // 都会让 score 对不上 → findIndex 返回 -1 → startIndex 归零 → 第二页从头再来，
  // 用户看到的就是"翻页一直在重复"。id 不可变，才是合格的锚点。
  let startIndex = 0
  if (cursor) {
    const idx = rows.findIndex((r) => r.id === cursor.i)
    if (idx !== -1) {
      startIndex = idx + 1 // 从 cursor 之后开始
    }
    // cursor 未找到（卡已被 supersede/新 build 覆盖）→ 从头开始
  }

  // 5. 切页
  const page = rows.slice(startIndex, startIndex + limit)
  const hasMore = startIndex + limit < rows.length
  const last = page[page.length - 1]
  const nextCursor = hasMore && last ? encodeCursor(last.score, last.id) : null

  // 6. 剩余可用卡数（含本页，供 route 层判断补卡阈值）
  const remaining = rows.length - startIndex

  return {
    cards: page,
    next_cursor: nextCursor,
    no_more: false, // no_more 仅在日上限达 100 时由 route 层置 true
    remaining,
  }
}

/**
 * 取「本轮新生成」的推荐卡（created_at 晚于给定时间点）。
 *
 * P0 闭环：补货只往队列尾部追加，而 Feed 首页按 score 排序取前 N 张——
 * 新卡几乎必然掉出首屏，于是"刚写完一篇 → 回 Feed 看到新方向"这条链在体感上
 * 从未发生。这里把本轮新卡单独取出，由 route 层前置到首屏。
 *
 * 分界点用「上次 build 已消费的事件时间」而非"最近 5 分钟"：
 * 前者语义就是"系统还没消化过的那批行为催生出来的卡"，与触发判定同源。
 */
export async function loadFreshSuggestions(
  supabase: SupabaseClient,
  userId: string,
  sinceIso: string,
  limit: number,
  opts: { rescore?: RescoreContext | null } = {}
): Promise<SuggestionRow[]> {
  const freshRows = (columns: string) =>
    supabase
      .from('interest_suggestions')
      .select(columns)
      .eq('user_id', userId)
      .eq('status', 'active')
      .gt('created_at', sinceIso)
      .order('score', { ascending: false })
      .order('id', { ascending: true })
      .limit(Math.max(1, limit))

  let { data, error } = await freshRows(SUGGESTION_RERANK_COLUMNS)
  if (error && rerankColumnsMissing(error)) {
    const fallback = await freshRows(SUGGESTION_BASE_COLUMNS)
    data = fallback.data
    error = fallback.error
  }
  if (error) {
    console.error('[feed] 查询本轮新卡失败:', error.message)
    return []
  }
  const rows = (data ?? []) as unknown as SuggestionRow[]
  return opts.rescore ? applyRescore(rows, opts.rescore) : rows
}

/**
 * 查当日已出卡数（recommend_impression 事件按 target_id 去重）。
 *
 * 日上限的正确口径：FEED_DAILY_CAP 要限制的是"用户当天看了多少张"，
 * 而不是"系统当天生成了多少张"。旧实现数的是生成量（created_at），
 * 补货一频繁就会在用户根本没翻几页时撞上 100 → no_more → 又变成"刷到哪就没了"。
 *
 * 兜底：若前端未上报 impression，本值恒为 0，日上限形同虚设——
 * 成本由 refill 的最小间隔（REFILL_MIN_INTERVAL_MS）兜底，不会失控。
 */
export async function getDailyServedCount(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const { data, error } = await supabase
    .from('creator_events')
    .select('target_id')
    .eq('user_id', userId)
    .eq('event_type', 'recommend_impression')
    .gte('occurred_at', todayStart.toISOString())
    .limit(500)
  if (error) {
    console.error('[feed] 查当日已出卡数失败:', error.message)
    return 0
  }
  const ids = new Set(
    (data ?? [])
      .map((r) => (r as { target_id?: unknown }).target_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  )
  return ids.size
}

/**
 * 查当日新增推荐卡数量（interest_suggestions created_at 按天）。
 * 仅作成本侧观测（generated_today），不再作为日上限依据——口径已改用
 * getDailyServedCount（用户实际看到的卡数）。
 */
export async function getDailySuggestionCount(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const { count, error } = await supabase
    .from('interest_suggestions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', todayStart.toISOString())
  if (error) {
    console.error('[feed] 查当日推荐卡计数失败:', error)
    return 0
  }
  return count ?? 0
}
