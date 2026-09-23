// ============================================================
// CI Store —— Supabase 持久化 + TTL 缓存（跨用户共享，省成本）
//
// 权限模型：ci_items / ci_search_log 两表 RLS 全关（无任何 anon 策略），
// 仅 service role 可读写（市场数据走 API route 中转，用户永远不直接查表；
// query 文本可能含用户私有想法，不跨用户暴露）。
//
// 降级设计：无 SUPABASE_SERVICE_ROLE_KEY 时所有函数静默空转——
// 缓存是优化不是依赖，数据层在没有数据库配置时仍完整可用。
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { CIItem } from './types'

/** service role 客户端（仅服务端使用）；未配置 key 返回 null（缓存降级） */
export function getServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** CIItem → 数据库行 */
function toRow(item: CIItem, queryHash: string) {
  return {
    platform: item.platform,
    external_id: item.external_id,
    url: item.url,
    title: item.title,
    excerpt: item.excerpt,
    author: item.author,
    published_at: item.published_at,
    metrics: item.metrics,
    content_info: item.content_info,
    ai_analysis: item.ai_analysis,
    // WFP1：语义向量随条目一起落库。此前 toRow 漏掉该列，导致 ci_items.embedding
    // 恒为 NULL，消费侧的相关性排序（S2 市场候选/Feed 热点补位）全部失效。
    embedding: item.embedding ?? null,
    query_hash: queryHash,
    fetched_at: item.fetched_at,
    expires_at: item.expires_at,
  }
}

/** 行 → CIItem（清洗失败返回 null） */
function fromRow(r: Record<string, unknown>): CIItem | null {
  const platform = r.platform
  const externalId = r.external_id
  const title = r.title
  if (typeof platform !== 'string' || typeof externalId !== 'string' || typeof title !== 'string') {
    return null
  }
  const metrics = (typeof r.metrics === 'object' && r.metrics !== null ? r.metrics : {}) as Record<string, unknown>
  const contentInfo = (typeof r.content_info === 'object' && r.content_info !== null ? r.content_info : {}) as Record<string, unknown>
  const ai = r.ai_analysis === null
    ? null
    : typeof r.ai_analysis === 'object' && r.ai_analysis !== null
      ? (r.ai_analysis as Record<string, unknown>)
      : null

  return {
    platform: platform as CIItem['platform'],
    external_id: externalId,
    url: typeof r.url === 'string' ? r.url : '',
    title,
    excerpt: typeof r.excerpt === 'string' ? r.excerpt : '',
    author: typeof r.author === 'string' ? r.author : '',
    published_at: typeof r.published_at === 'string' ? r.published_at : null,
    metrics: {
      play_count: typeof metrics.play_count === 'number' ? metrics.play_count : null,
      like_count: typeof metrics.like_count === 'number' ? metrics.like_count : null,
      comment_count: typeof metrics.comment_count === 'number' ? metrics.comment_count : null,
      collect_count: typeof metrics.collect_count === 'number' ? metrics.collect_count : null,
    },
    content_info: {
      topic: typeof contentInfo.topic === 'string' ? contentInfo.topic : '',
      keywords: Array.isArray(contentInfo.keywords) ? contentInfo.keywords.filter((k): k is string => typeof k === 'string') : [],
      content_type: typeof contentInfo.content_type === 'string' ? contentInfo.content_type : '',
    },
    ai_analysis: ai
      ? {
          opening_structure: typeof ai.opening_structure === 'string' ? ai.opening_structure : null,
          core_viewpoint: typeof ai.core_viewpoint === 'string' ? ai.core_viewpoint : null,
          emotion_type: typeof ai.emotion_type === 'string' ? ai.emotion_type : null,
          narrative_structure: typeof ai.narrative_structure === 'string' ? ai.narrative_structure : null,
          user_feedback: typeof ai.user_feedback === 'string' ? ai.user_feedback : null,
          reference_value: typeof ai.reference_value === 'string' ? ai.reference_value : null,
        }
      : null,
    fetched_at: typeof r.fetched_at === 'string' ? r.fetched_at : new Date().toISOString(),
    expires_at: typeof r.expires_at === 'string' ? r.expires_at : new Date().toISOString(),
    embedding: parseEmbedding(r.embedding),
  }
}

/**
 * 行 → 向量。pgvector 经 PostgREST 多数返回 number[]，个别场景返回
 * "[0.1,...]" 字符串，两种都接受；任何异常一律 null（检索降级，不冒充零向量）。
 */
function parseEmbedding(v: unknown): number[] | null {
  const isNums = (a: unknown[]): a is number[] => a.every((n) => typeof n === 'number')
  if (Array.isArray(v)) return isNums(v) ? v : null
  if (typeof v === 'string') {
    try {
      const arr: unknown = JSON.parse(v)
      return Array.isArray(arr) && isNums(arr) ? arr : null
    } catch {
      return null
    }
  }
  return null
}

/** 缓存读取：返回指定 query_hash 的未过期条目；任何错误返回空数组（降级为无缓存） */
export async function findFreshItems(queryHash: string, limit = 12): Promise<CIItem[]> {
  const db = getServiceClient()
  if (!db) return []
  try {
    const { data, error } = await db
      .from('ci_items')
      .select('*')
      .eq('query_hash', queryHash)
      .gt('expires_at', new Date().toISOString())
      .order('fetched_at', { ascending: false })
      .limit(limit)
    if (error || !data) return []
    return data.map((r) => fromRow(r as Record<string, unknown>)).filter((x): x is CIItem => x !== null)
  } catch (e) {
    console.error('CI store findFreshItems 异常:', e)
    return []
  }
}

/** 缓存写入：批量 upsert（platform+external_id 冲突时刷新 ai_analysis 与 TTL）；失败静默 */
export async function upsertItems(items: CIItem[], queryHash: string): Promise<void> {
  const db = getServiceClient()
  if (!db || items.length === 0) return
  try {
    const { error } = await db
      .from('ci_items')
      .upsert(items.map((it) => toRow(it, queryHash)), { onConflict: 'platform,external_id' })
    if (error) console.error('CI store upsertItems 失败:', error.message)
  } catch (e) {
    console.error('CI store upsertItems 异常:', e)
  }
}

/** 搜索日志（成本监控 + 缓存命中率分析）；失败静默 */
export async function logSearch(entry: {
  query_hash: string
  query_text: string
  adapters: string[]
  item_count: number
}): Promise<void> {
  const db = getServiceClient()
  if (!db) return
  try {
    await db.from('ci_search_log').insert({
      query_hash: entry.query_hash,
      query_text: entry.query_text.slice(0, 400),
      adapters: entry.adapters,
      item_count: entry.item_count,
    })
  } catch (e) {
    console.error('CI store logSearch 异常:', e)
  }
}
