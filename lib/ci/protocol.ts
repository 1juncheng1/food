// ============================================================
// WF8：ExternalTrendData ↔ CIItem 协议转换缝
//
//   externalTrendToCIItem —— 未来外部平台数据 → ci_items 管线
//   ciItemToExternalTrend —— ci_items → 外部协议（S2 出口经此转换）
//
// 诚实红线：stub 阶段拿不到的指标一律 null（play/like/published/trendScore），
// 永不为 0 或估算值冒充真值。
// ============================================================

import type { CIItem, CIPlatform, ExternalTrendData } from './types'

const CONTENT_TYPE_BY_PLATFORM: Partial<Record<CIPlatform, string>> = {
  douyin: 'video',
  bilibili: 'video',
  zhihu: 'answer',
  web_search: 'webpage',
  news: 'news',
}

const TTL_MS = 7 * 24 * 3_600_000

/** 外部热点数据 → 统一 CIItem（进 ci_items 管线） */
export function externalTrendToCIItem(t: ExternalTrendData, now = new Date()): CIItem {
  return {
    platform: t.platform,
    external_id: t.externalId,
    url: t.url,
    title: t.title,
    excerpt: t.excerpt.slice(0, 300), // 版权红线：永不存全文
    author: '',
    published_at: null,
    metrics: { play_count: null, like_count: null, comment_count: null, collect_count: null },
    content_info: {
      topic: '',
      keywords: t.dimensions ?? [],
      content_type: CONTENT_TYPE_BY_PLATFORM[t.platform] ?? 'webpage',
    },
    ai_analysis: null,
    fetched_at: t.fetchedAt || now.toISOString(),
    expires_at: new Date(now.getTime() + TTL_MS).toISOString(),
  }
}

/** ci_items 行 → 外部协议（S2 出口协议转换；只需要基础字段） */
export function ciItemToExternalTrend(i: Pick<
  CIItem,
  'platform' | 'external_id' | 'url' | 'title' | 'excerpt' | 'fetched_at'
>): ExternalTrendData {
  return {
    platform: i.platform,
    externalId: i.external_id,
    url: i.url,
    title: i.title,
    excerpt: i.excerpt,
    trendScore: null, // ci_items 无平台热度真值：null 而非 0
    fetchedAt: i.fetched_at,
  }
}
