// ============================================================
// CI Adapters —— Tavily 网页搜索 / 新闻双适配（P0 唯一真实数据源）
//
// Tavily API：POST https://api.tavily.com/search
//   topic: 'general'（网页）/ 'news'（新闻），返回 results[]: { title, url, content, score, published_date }
//
// 能力现实（架构红线：不假装数据存在）：
//   - 无播放/点赞/评论/收藏指标 → metrics 全 null，capabilities.metrics = []
//   - published_date 仅部分结果有（新闻较稳）→ 拿不到就 null
//   - 无评论文本 → ai_analysis.user_feedback 永远 null
// ============================================================

import { createHash } from 'node:crypto'
import type { CIItem, CIPlatform, CIQuery, CISourceAdapter } from '../types'
import { safeText, truncate } from '../types'

/** URL → 稳定 external_id（跨请求去重的主键来源） */
function urlToExternalId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 40)
}

interface TavilyResult {
  title?: unknown
  url?: unknown
  content?: unknown
  published_date?: unknown
  score?: unknown
}

interface TavilyResponse {
  results?: TavilyResult[]
}

/** Tavily 单条结果 → 统一 CIItem（清洗失败返回 null） */
export function normalizeTavilyResult(
  raw: TavilyResult,
  platform: CIPlatform,
  contentType: string,
  topic: string,
  now: string,
  expiresAt: string
): CIItem | null {
  const url = safeText(raw.url, 500)
  const title = safeText(raw.title, 200)
  if (!url || !title) return null

  // published_date：仅当是合理 ISO 日期串才保留，否则 null（不编造）
  const rawDate = typeof raw.published_date === 'string' ? raw.published_date.trim() : ''
  const publishedAt = rawDate && !Number.isNaN(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null

  return {
    platform,
    external_id: urlToExternalId(url),
    url,
    title,
    excerpt: truncate(safeText(raw.content, 2000), 300),
    author: '', // Tavily 不提供作者，留空（未来平台源填充）
    published_at: publishedAt,
    metrics: { play_count: null, like_count: null, comment_count: null, collect_count: null },
    content_info: { topic, keywords: [], content_type: contentType },
    ai_analysis: null,
    fetched_at: now,
    expires_at: expiresAt,
  }
}

/** Tavily 搜索公共实现：失败返回空数组，不抛异常（扇出容错） */
async function tavilySearch(
  platform: CIPlatform,
  contentType: string,
  ttlHours: number,
  query: CIQuery,
  limit: number
): Promise<{ items: CIItem[]; error?: string }> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) return { items: [], error: 'missing_api_key' }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: query.topic.slice(0, 400),
        topic: platform === 'news' ? 'news' : 'general',
        max_results: Math.max(1, Math.min(20, limit)),
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
      }),
    })
    if (!res.ok) {
      return { items: [], error: `tavily_http_${res.status}` }
    }
    const data = (await res.json()) as TavilyResponse
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString()

    const items: CIItem[] = []
    for (const r of data.results ?? []) {
      const item = normalizeTavilyResult(r, platform, contentType, query.topic, now, expiresAt)
      if (item) items.push(item)
      if (items.length >= limit) break
    }
    return { items }
  } catch (e) {
    console.error(`CI Tavily(${platform}) 搜索异常:`, e)
    return { items: [], error: 'tavily_exception' }
  }
}

/** 网页搜索 Adapter（TTL 72h：网页内容时效性中等） */
export const webSearchAdapter: CISourceAdapter = {
  id: 'web_search',
  capabilities: { metrics: [], publishedAt: true, comments: false },
  search(query, limit) {
    return tavilySearch('web_search', 'webpage', 72, query, limit)
  },
}

/** 新闻 Adapter（TTL 24h：新闻时效性强） */
export const newsAdapter: CISourceAdapter = {
  id: 'news',
  capabilities: { metrics: [], publishedAt: true, comments: false },
  search(query, limit) {
    return tavilySearch('news', 'news', 24, query, limit)
  },
}
