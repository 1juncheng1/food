// ============================================================
// P1（WF11）：全局创作热点摄取（冷启动真实"大众创作方向"数据源）
//
// 为什么需要：ci_items 此前只在用户生成文案时按其主题窄搜写入，新用户/游客
// 冷启动看到的是静态手写模板。本模块按创作大类每日懒触发一轮广域搜索
// （Tavily 全网+新闻 → ciSearch 既有富化/去重/落库），结果跨用户共享。
//
// 幂等/成本：
//   - 逻辑分区：query_hash = `global:v1:<UTC-date>`，日 hash 即逻辑日 TTL
//     （物理 expires_at 沿用 adapter：web 72h / news 24h）
//   - 计数闸门：当日全局行 ≥ GLOBAL_TRENDING_FRESH_MIN 时直接 skipped
//   - 在途锁：同进程并发（多标签页/多请求）只放一轮，第二个调用拿到 locked
//   - 串行扇出：6 大类逐个 ciSearch，避免瞬时 12 个搜索请求打满 Tavily 限流
//
// 降级哲学（与 ciSearch 一致）：任何失败只记日志、返回空/失败状态，绝不抛到
// 冷启动响应路径——调用方（/api/inspirations）负责回退静态模板。
// ============================================================

import { ciSearch } from './service'
import { getServiceClient } from './store'

export const GLOBAL_HASH_PREFIX = 'global:v1:'

/** 当日全局行达到此数量即视为已摄取，跳过搜索（跨用户共享的日闸门） */
export const GLOBAL_TRENDING_FRESH_MIN = 12

/**
 * 全局热点大类（固定 6 类，覆盖平台目标创作者的主流方向）。
 * topic 直接作为 Tavily 搜索词；content_domain 仅保留领域语义（hash 被 override，
 * 不参与分区）。
 */
export const GLOBAL_TRENDING_CATEGORIES: ReadonlyArray<{ topic: string; content_domain: string }> = [
  { topic: 'AI工具最新趋势 创作者', content_domain: 'AI工具' },
  { topic: '副业变现新方向 2026', content_domain: '副业' },
  { topic: '自媒体运营爆款技巧', content_domain: '自媒体' },
  { topic: '职场成长个人提升热门话题', content_domain: '职场' },
  { topic: '情感故事爆款选题', content_domain: '情感故事' },
  { topic: '知识科普热门选题', content_domain: '知识科普' },
]

/** 每类搜索条数（ciSearch 内部还会做去重与 Top8 富化） */
const GLOBAL_PER_CATEGORY_LIMIT = 8

/** 全局热点日分区 hash：global:v1:YYYY-MM-DD（UTC，可注入 now 便于测试跨日） */
export function globalHashFor(now: Date = new Date()): string {
  // toISOString 前 10 位即 UTC YYYY-MM-DD
  return `${GLOBAL_HASH_PREFIX}${now.toISOString().slice(0, 10)}`
}

// ── 模块级 TTL 缓存（P1-6 优化）──
// getGlobalTrending 是纯 DB 读 + 跨用户共享（无 userId 维度），
// 是冷启动路径的关键调用，缓存收益高。
// 设计要点：
//   - 缓存 key 含 limit + 日期 hash（避免跨日命中）
//   - 只缓存非空结果（空结果不缓存，避免 5 分钟内一直返回空）
//   - ingestGlobalTrending 完成后清缓存（让下次读拿到新数据）
//   - 进程内不共享（多实例各自缓存），但有 TTL 兜底 + DB 兜底
interface CacheEntry<T> {
  value: T
  expiresAt: number
}
const globalTrendingCache = new Map<string, CacheEntry<GlobalTrendingCard[]>>()
const GLOBAL_TRENDING_CACHE_TTL = 5 * 60 * 1000 // 5 分钟

/** 清空全局热点缓存（ingestGlobalTrending 完成后调用） */
function invalidateGlobalTrendingCache() {
  globalTrendingCache.clear()
  trendingRowsCache.clear()
}

/** 出参给冷启动卡片消费的脱敏结构（严禁携带 query_hash / ai_analysis 原文，红线同 S2） */
export interface GlobalTrendingCard {
  title: string
  description: string
  /** 大类名（卡片角标/参数用） */
  category: string
  url: string | null
  platform: string | null
}

interface CiItemRow {
  title?: unknown
  excerpt?: unknown
  url?: unknown
  platform?: unknown
  content_info?: { topic?: unknown } | null
  ai_analysis?: { reference_value?: unknown } | null
  /** 语义向量（WFP1 落库补算）；老数据为 null，检索侧按无向量降级 */
  embedding?: unknown
}

/**
 * 行 → 脱敏卡片（全网热点与兴趣热点共用同一映射口径）。
 * 映射口径：描述 = excerpt → 富化参考价值 → 标题，保证卡片永不空白描述。
 */
function mapTrendingRows(rows: CiItemRow[]): GlobalTrendingCard[] {
  return rows
    .map((r) => {
      const title = typeof r.title === 'string' ? r.title.trim() : ''
      if (!title) return null
      const excerpt = typeof r.excerpt === 'string' ? r.excerpt.trim() : ''
      const refValue =
        r.ai_analysis && typeof r.ai_analysis.reference_value === 'string'
          ? r.ai_analysis.reference_value.trim()
          : ''
      return {
        title,
        description: (excerpt || refValue || title).slice(0, 120),
        category:
          typeof r.content_info?.topic === 'string' && r.content_info.topic
            ? r.content_info.topic
            : '热门选题',
        url: typeof r.url === 'string' && r.url ? r.url : null,
        platform: typeof r.platform === 'string' && r.platform ? r.platform : null,
      } satisfies GlobalTrendingCard
    })
    .filter((c): c is GlobalTrendingCard => c !== null)
}

/**
 * 读当日未过期全局热点（纯读路径）。
 * 未配置 service client / 查询异常 / 空结果 → []，由调用方回退静态模板。
 *
 * P1-6：加 5 分钟 TTL 内存缓存（跨用户共享，无 userId 维度）。
 * - 命中缓存立即返回（避免 DB 查询）
 * - 未命中走 DB，非空结果写入缓存
 * - 空结果不缓存（避免 5 分钟内一直返回空）
 */
export async function getGlobalTrending(limit = 3, now: Date = new Date()): Promise<GlobalTrendingCard[]> {
  // 1. 缓存命中检查（key 含 limit + 日期 hash，避免跨日命中）
  const cacheKey = `gt:${limit}:${globalHashFor(now)}`
  const cached = globalTrendingCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  // 2. 未命中 → 走 DB
  const db = getServiceClient()
  if (!db) return []
  try {
    const { data, error } = await db
      .from('ci_items')
      .select('title, excerpt, url, platform, ai_analysis, content_info, fetched_at')
      .eq('query_hash', globalHashFor(now))
      .gt('expires_at', now.toISOString())
      .order('fetched_at', { ascending: false })
      .limit(limit)
    if (error) {
      console.warn('[ci] 全局热点读取失败:', error.message)
      return []
    }
    if (!Array.isArray(data) || data.length === 0) return []

    // 映射口径：描述 = 摘要 excerpt；摘要缺失时用富化参考价值兜底；再缺用标题，
    // 保证卡片永不出现空白描述。
    const result = mapTrendingRows(data as CiItemRow[])

    // 3. 非空结果写入缓存（空结果不缓存，避免长期返回空）
    if (result.length > 0) {
      globalTrendingCache.set(cacheKey, {
        value: result,
        expiresAt: Date.now() + GLOBAL_TRENDING_CACHE_TTL,
      })
    }
    return result
  } catch (e) {
    console.warn('[ci] 全局热点读取异常:', e instanceof Error ? e.message : String(e))
    return []
  }
}

// ── WFP1：「兴趣 × 热点」交叉检索 ──
//
// 为什么需要：getGlobalTrending 按 fetched_at 倒序取当日热点，与用户兴趣无关——
// Feed 缺卡时补进来的可能是毫不相干的方向，用户体感就是"推荐变水了"。
// 交叉检索用用户兴趣簇质心在当日热点池里做向量召回，让补位卡与用户方向对齐。
//
// 为什么应用端排序而不用 match_ci_items RPC：
//   ci_items 每日全局行 O(10^2)，HNSW 索引的收益要到 O(10^5+) 才显现；
//   应用端排序免掉一次 DB 迁移依赖（用户不必执行 SQL），且当日行可整批缓存复用。
//   规模上来后再上 RPC——setup.sql 的 ci_items_embedding_hnsw_idx 已经就位。

/** 交叉检索最低相似度：低于此视为无关热点，宁可不补也不硬塞 */
export const TRENDING_MATCH_MIN_SIM = 0.3

/** 单次交叉检索扫描的当日热点行数上限（当日全局行量级 O(10^2)，全量足够） */
const TRENDING_ROWS_SCAN = 60

/** 带相关度的热点卡（similarity 仅用于排序与可观测，不进前端响应） */
export interface PersonalizedTrendingCard extends GlobalTrendingCard {
  similarity: number
}

/** 当日热点行（含向量）缓存：跨用户共享，避免每个用户各拉一次 1024 维大列 */
const trendingRowsCache = new Map<string, CacheEntry<CiItemRow[]>>()

/**
 * 读当日热点行（含 embedding），带 5 分钟进程内缓存。
 * 跨用户共享同一份（无 userId 维度），摄取完成时与卡片缓存一起失效。
 */
async function loadTrendingRows(now: Date): Promise<CiItemRow[]> {
  const dayKey = globalHashFor(now)
  const cached = trendingRowsCache.get(dayKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const db = getServiceClient()
  if (!db) return []
  try {
    // 交叉检索需要完整候选池，不能只取 Top N
    const { data, error } = await db
      .from('ci_items')
      .select('title, excerpt, url, platform, ai_analysis, content_info, embedding')
      .eq('query_hash', dayKey)
      .gt('expires_at', now.toISOString())
      .order('fetched_at', { ascending: false })
      .limit(TRENDING_ROWS_SCAN)
    if (error || !Array.isArray(data) || data.length === 0) return []
    const rows = data as CiItemRow[]
    trendingRowsCache.set(dayKey, {
      value: rows,
      expiresAt: Date.now() + GLOBAL_TRENDING_CACHE_TTL,
    })
    return rows
  } catch (e) {
    console.warn('[ci] 当日热点行读取异常:', e instanceof Error ? e.message : String(e))
    return []
  }
}

/** 余弦相似度（本地实现：ci 是底层数据层，不反向依赖 interest/vectorMath） */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 用用户兴趣向量在当日全局热点池里召回最相关的热点。
 *
 * 降级链（任一环为空都安全返回 []，由调用方回退 getGlobalTrending）：
 *   无兴趣向量 → 无当日热点 → 无向量行 → 全池低于相似度阈值
 */
export async function getPersonalizedTrending(
  userCentroid: number[] | null,
  limit = 3,
  now: Date = new Date()
): Promise<PersonalizedTrendingCard[]> {
  if (!Array.isArray(userCentroid) || userCentroid.length === 0) return []

  const rows = await loadTrendingRows(now)
  if (!rows.length) return []

  const scored: Array<{ row: CiItemRow; sim: number }> = []
  for (const row of rows) {
    const emb = Array.isArray(row.embedding) ? (row.embedding as number[]) : null
    if (!emb || emb.length !== userCentroid.length) continue
    const sim = cosine(emb, userCentroid)
    if (sim >= TRENDING_MATCH_MIN_SIM) scored.push({ row, sim })
  }
  if (!scored.length) return []

  scored.sort((a, b) => b.sim - a.sim)
  const out: PersonalizedTrendingCard[] = []
  for (const { row, sim } of scored) {
    const card = mapTrendingRows([row])[0]
    if (!card) continue
    out.push({ ...card, similarity: Math.round(sim * 1000) / 1000 })
    if (out.length >= limit) break
  }
  return out
}

// 进程内在途锁：key=日 hash。serverless 多实例不共享，但先有计数闸门兜底
// （重复摄取最坏代价为一轮搜索费，upsert 按 platform+external_id 幂等）。
const inflightDays = new Set<string>()

// 同进程内两次「真实摄取尝试」的最小间隔。
// 在途锁只挡并发挡不住串行重试：摄取失败返回 failed 后，下一个请求会立刻再来一轮，
// 高频刷新即可在一天内打出上百次付费搜索。日闸门只在成功摄取后才生效，
// 因此必须补这道时间闸门，让成本与请求频率解耦。
const INGEST_MIN_INTERVAL_MS = 10 * 60 * 1000
let lastIngestAttemptAt = 0

export type IngestResult = 'ingested' | 'skipped' | 'locked' | 'failed'

/**
 * 懒触发全局热点摄取（fire-and-forget 调用）。
 * 顺序：在途锁 → 计数闸门 → 6 大类串行 ciSearch（共享日 hash）。
 * 任何一类失败不中断其余类别；全部零产出返回 failed（调用方无需特殊处理，
 * 冷启动仍走静态模板，下个请求会重试）。
 */
export async function ingestGlobalTrending(now: Date = new Date()): Promise<IngestResult> {
  const hash = globalHashFor(now)
  // 加锁必须在第一个 await 之前同步完成：并发调用（同进程两个请求）才能被挡住
  if (inflightDays.has(hash)) return 'locked'
  inflightDays.add(hash)

  // 时间闸门：距上次真实尝试不足 10 分钟直接跳过（失败重试也被一并挡住）
  if (Date.now() - lastIngestAttemptAt < INGEST_MIN_INTERVAL_MS) return 'locked'
  lastIngestAttemptAt = Date.now()

  try {
    // 闸门：当日已有足量全局行 → 全平台一天只摄取这一轮
    const existing = await getGlobalTrending(GLOBAL_TRENDING_FRESH_MIN, now)
    if (existing.length >= GLOBAL_TRENDING_FRESH_MIN) return 'skipped'

    let totalItems = 0
    // 串行而非 Promise.all：避免对 Tavily 瞬时打出 6×2 个并发搜索请求触发限流
    for (const cat of GLOBAL_TRENDING_CATEGORIES) {
      try {
        const result = await ciSearch({
          topic: cat.topic,
          content_domain: cat.content_domain,
          maxItems: GLOBAL_PER_CATEGORY_LIMIT,
          hashOverride: hash,
        })
        totalItems += result.items.length
      } catch (e) {
        // 单类失败不中断：其余类别照常摄取
        console.warn('[ci] 全局热点大类摄取失败:', cat.topic, e instanceof Error ? e.message : String(e))
      }
    }
    return totalItems > 0 ? 'ingested' : 'failed'
  } finally {
    inflightDays.delete(hash)
    // 摄取完成后清缓存，让下次 getGlobalTrending 读到新数据（P1-6）
    invalidateGlobalTrendingCache()
  }
}
