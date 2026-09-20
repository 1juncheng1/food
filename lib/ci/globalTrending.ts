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
}

/**
 * 读当日未过期全局热点（纯读路径）。
 * 未配置 service client / 查询异常 / 空结果 → []，由调用方回退静态模板。
 */
export async function getGlobalTrending(limit = 3, now: Date = new Date()): Promise<GlobalTrendingCard[]> {
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
    return (data as CiItemRow[])
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
          category: typeof r.content_info?.topic === 'string' && r.content_info.topic
            ? r.content_info.topic
            : '热门选题',
          url: typeof r.url === 'string' && r.url ? r.url : null,
          platform: typeof r.platform === 'string' && r.platform ? r.platform : null,
        } satisfies GlobalTrendingCard
      })
      .filter((c): c is GlobalTrendingCard => c !== null)
  } catch (e) {
    console.warn('[ci] 全局热点读取异常:', e instanceof Error ? e.message : String(e))
    return []
  }
}

// 进程内在途锁：key=日 hash。serverless 多实例不共享，但先有计数闸门兜底
// （重复摄取最坏代价为一轮搜索费，upsert 按 platform+external_id 幂等）。
const inflightDays = new Set<string>()

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
  }
}
