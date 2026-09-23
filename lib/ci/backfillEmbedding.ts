// ============================================================
// ci_items 存量语义向量回填（WFP1）
//
// 为什么需要：ci_items.embedding 自 WF0 建列以来从未写入（store.toRow 漏了该列）。
// 修复后的 ciSearch 只会给「新增」条目补算，存量行仍然是 NULL——不回填的话，
// S2 市场候选（getMarketCandidates）与 Feed 兴趣热点补位（getPersonalizedTrending）
// 在真机上要等下一轮摄取才有数据可用，P1 的收益被推迟一天。
//
// 性质：一次性运维操作。串行调用 bge-m3（不并发，避免打满额度），
// 默认 100 条/次；返回 remaining > 0 表示还有存量，再调一次即可。
// ============================================================

import { getServiceClient } from './store'
import { generateEmbedding } from '../storage'

export interface EmbeddingBackfillStats {
  /** 本次扫描到的无向量行数 */
  scanned: number
  /** 本次成功补算并写回的行数 */
  embedded: number
  /** 本次失败行数（无文本 / 向量调用失败 / 写回失败） */
  failed: number
  /** 全表仍未补算的行数（>0 表示还需再跑一次） */
  remaining: number
}

/** 未配置 service role key 时的空结果（缓存缺失是降级而非故障） */
const EMPTY: EmbeddingBackfillStats = { scanned: 0, embedded: 0, failed: 0, remaining: 0 }

/**
 * 给 ci_items 中 embedding 为 NULL 的行补算向量（title + excerpt）。
 * 任何单条失败都不中断整批（向量是检索增强，缺个别行不影响可用性）。
 */
export async function backfillCiEmbeddings(limit = 100): Promise<EmbeddingBackfillStats> {
  const db = getServiceClient()
  if (!db) return EMPTY

  const { data, error } = await db
    .from('ci_items')
    .select('id, title, excerpt')
    .is('embedding', null)
    .limit(limit)
  if (error) {
    console.error('[ci] 向量回填查询失败:', error.message)
    return EMPTY
  }

  const rows = (data ?? []) as Array<{
    id: string
    title: string | null
    excerpt: string | null
  }>
  if (!rows.length) return EMPTY

  let embedded = 0
  let failed = 0
  for (const r of rows) {
    const text = [r.title, r.excerpt].filter(Boolean).join('\n').trim()
    if (!text) {
      failed++
      continue
    }
    try {
      const vec = await generateEmbedding(text)
      if (!vec || vec.length !== 1024) {
        failed++
        continue
      }
      const { error: upErr } = await db
        .from('ci_items')
        .update({ embedding: vec })
        .eq('id', r.id)
      if (upErr) {
        failed++
        continue
      }
      embedded++
    } catch (e) {
      console.warn('[ci] 向量回填单条失败:', e instanceof Error ? e.message : String(e))
      failed++
    }
  }

  // 剩余存量含本次失败的行：调用方据 remaining 决定是否再跑一次
  const { count } = await db
    .from('ci_items')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null)

  return { scanned: rows.length, embedded, failed, remaining: count ?? 0 }
}
