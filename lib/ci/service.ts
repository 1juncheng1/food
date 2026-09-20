// ============================================================
// CI Service —— 数据层编排入口
//
// ciSearch(query)：
//   1. 缓存检查（query_hash 命中且未过期 → 直接返回，省搜索费+富化费）
//   2. Adapter 扇出（并行）→ 统一清洗
//   3. 去重（external_id + 归一化标题）
//   4. 批量富化 Top 8（一次 LLM 调用）
//   5. 落库（best effort）+ 搜索日志（成本监控）
//
// 降级哲学：任何一层失败都不抛异常——返回空/部分结果，由调用方决定回退策略。
// ============================================================

import { createHash } from 'node:crypto'
import type { CIItem, CIQuery } from './types'
import { getEnabledAdapters } from './registry'
import { enrichItems } from './enrich'
import { findFreshItems, logSearch, upsertItems } from './store'

/** 查询指纹：归一化主题 + 领域，决定缓存命中 */
export function queryHashOf(topic: string, contentDomain?: string): string {
  const normalized = topic.trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256').update(`${normalized}|${contentDomain ?? ''}`).digest('hex').slice(0, 32)
}

/** 标题归一化去重键：去空白/标点后小写 */
function titleKey(title: string): string {
  return title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 去重：external_id 优先，归一化标题兜底（同一热点多源报道合并） */
export function dedupeItems(items: CIItem[]): CIItem[] {
  const seenIds = new Set<string>()
  const seenTitles = new Set<string>()
  const out: CIItem[] = []
  for (const it of items) {
    if (seenIds.has(it.external_id)) continue
    const tk = titleKey(it.title)
    if (tk && seenTitles.has(tk)) continue
    seenIds.add(it.external_id)
    if (tk) seenTitles.add(tk)
    out.push(it)
  }
  return out
}

export interface CISearchResult {
  items: CIItem[]
  /** 是否命中缓存（命中 = 本次零搜索费零富化费） */
  cacheHit: boolean
  /** 无可用数据源（未配置 key）时为 true，调用方应回退估算模式 */
  noAdapters: boolean
}

const MIN_FRESH_FOR_CACHE = 6 // 缓存里至少有这么多新鲜条目才免搜索
const SEARCH_LIMIT = 8 // 每个 Adapter 请求条数（Top N 语义）

export async function ciSearch(query: CIQuery): Promise<CISearchResult> {
  // P1：全局热点摄取传 hashOverride（global:v1:<date>），让各大类共享日分区；
  // 普通用户窄搜缺省走 topic+content_domain 计算 hash，语义不变。
  const hash = query.hashOverride ?? queryHashOf(query.topic, query.content_domain)
  const adapters = getEnabledAdapters()
  const adapterIds = adapters.map((a) => a.id)

  // 1. 缓存检查
  const fresh = await findFreshItems(hash)
  if (fresh.length >= MIN_FRESH_FOR_CACHE) {
    void logSearch({ query_hash: hash, query_text: query.topic, adapters: adapterIds, item_count: fresh.length })
    return { items: fresh, cacheHit: true, noAdapters: false }
  }

  // 2. 无【真实】数据源（stub 在册不算，WF8）：调用方回退估算模式
  if (adapters.every((a) => a.stub)) {
    return { items: [], cacheHit: false, noAdapters: true }
  }

  // 3. 扇出（并行；单个 Adapter 失败不影响其他源）
  const limit = Math.max(1, Math.min(20, query.maxItems ?? SEARCH_LIMIT))
  const settled = await Promise.allSettled(adapters.map((a) => a.search(query, limit)))
  const raw: CIItem[] = []
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value.items.length > 0) raw.push(...r.value.items)
  }

  // 4. 清洗 + 去重
  const items = dedupeItems(raw)
  if (items.length === 0) {
    void logSearch({ query_hash: hash, query_text: query.topic, adapters: adapterIds, item_count: 0 })
    return { items: [], cacheHit: false, noAdapters: false }
  }

  // 5. 批量富化 Top 8（一次 LLM 调用；失败时 ai_analysis 保持 null）
  const enriched = await enrichItems(items)

  // 6. 落库 + 日志（best effort，失败不阻塞）
  void upsertItems(enriched, hash)
  void logSearch({ query_hash: hash, query_text: query.topic, adapters: adapterIds, item_count: enriched.length })

  return { items: enriched, cacheHit: false, noAdapters: false }
}
