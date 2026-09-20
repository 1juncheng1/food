// ============================================================
// WF8：ExternalTrendData 标准协议 + 双向转换器
//
// 未来接入抖音/B站/知乎热点时的统一数据结构（阶段8预留）。
// 转换器是协议转换缝：
//   externalTrendToCIItem —— 外部平台数据 → ci_items 管线（metrics 全 null：
//                            stub 阶段拿不到真值，红线"null 而非 0 冒充"）
//   ciItemToExternalTrend —— ci_items → 外部协议（S2 出口经此转换）
// ============================================================

import { describe, expect, it } from 'vitest'
import { externalTrendToCIItem, ciItemToExternalTrend } from './protocol'
import type { ExternalTrendData } from './types'

const TREND: ExternalTrendData = {
  platform: 'bilibili',
  externalId: 'BV1xx411c7mD',
  url: 'https://www.bilibili.com/video/BV1xx411c7mD',
  title: 'AI 正在改变普通人的工作方式',
  excerpt: '一条关于 AI 与职业转型的热门视频',
  dimensions: ['科技', '观点拆解'],
  trendScore: 0.87,
  fetchedAt: '2026-09-19T08:00:00Z',
}

describe('externalTrendToCIItem（外部平台 → ci_items 管线）', () => {
  it('字段映射完整：platform/external_id/url/title/excerpt 保真', () => {
    const item = externalTrendToCIItem(TREND)
    expect(item.platform).toBe('bilibili')
    expect(item.external_id).toBe('BV1xx411c7mD')
    expect(item.url).toBe(TREND.url)
    expect(item.title).toBe(TREND.title)
    expect(item.excerpt).toBe(TREND.excerpt)
  })

  it('metrics 全 null、ai_analysis null、published_at null（无真值不编造）', () => {
    const item = externalTrendToCIItem(TREND)
    expect(item.metrics).toEqual({ play_count: null, like_count: null, comment_count: null, collect_count: null })
    expect(item.ai_analysis).toBeNull()
    expect(item.published_at).toBeNull()
  })

  it('content_type 按平台映射；dimensions 进 keywords；TTL 7 天', () => {
    const item = externalTrendToCIItem(TREND)
    expect(item.content_info.content_type).toBe('video')
    expect(item.content_info.keywords).toEqual(['科技', '观点拆解'])
    expect(item.content_info.topic).toBe('')
    expect(Date.parse(item.expires_at)).toBeGreaterThan(Date.parse(item.fetched_at))
    const zhihu = externalTrendToCIItem({ ...TREND, platform: 'zhihu' })
    expect(zhihu.content_info.content_type).toBe('answer')
  })

  it('excerpt 超 300 字截断（版权红线：永不存全文）', () => {
    const item = externalTrendToCIItem({ ...TREND, excerpt: '长'.repeat(500) })
    expect(item.excerpt.length).toBeLessThanOrEqual(300)
  })
})

describe('ciItemToExternalTrend（ci_items → 外部协议，S2 出口用）', () => {
  it('字段映射保真；trendScore 为 null（ci_items 无热度真值，红线不估 0）', () => {
    const t = ciItemToExternalTrend({
      platform: 'douyin',
      external_id: 'dy-123',
      url: 'https://v.douyin.com/x',
      title: '短视频选题',
      excerpt: '摘要',
      fetched_at: '2026-09-19T07:00:00Z',
    })
    expect(t).toEqual({
      platform: 'douyin',
      externalId: 'dy-123',
      url: 'https://v.douyin.com/x',
      title: '短视频选题',
      excerpt: '摘要',
      trendScore: null,
      fetchedAt: '2026-09-19T07:00:00Z',
    })
  })
})
