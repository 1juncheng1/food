// ============================================================
// WF8：S2 出口经 ExternalTrendData 协议转换（行为保持重构）
//
// getMarketCandidates 的候选映射改为经 ciItemToExternalTrend 标准出口，
// 外部可观测行为必须完全不变（title/topic/marketRefs/contentValue）。
// 同时回归 ciSearch 的 noAdapters 语义：stub 常驻在册后，无真实源
// 仍必须回退估算模式（这是 stub 注册最隐蔽的破坏点）。
// ============================================================

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { getMarketCandidates } from './suggestionSynthesizer'
import type { SupabaseClient } from '@supabase/supabase-js'

// ── S2：mock service client 返回一条 ci_item ──

const centroid = [0.5, 0.5, 0.5, 0.5]

function mockDbWithRows(rows: unknown[]) {
  const node: Record<string, unknown> = {}
  const terminal = Object.assign(vi.fn().mockResolvedValue({ data: rows, error: null }), node)
  node.select = vi.fn(() => node)
  node.gt = vi.fn(() => node)
  node.gte = vi.fn(() => node)
  node.order = vi.fn(() => node)
  node.limit = terminal
  const db = { from: vi.fn(() => node) }
  return { db, terminal }
}

vi.mock('../../ci/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getServiceClient: () => (globalThis as { __wf8Db?: unknown }).__wf8Db,
}))

beforeEach(() => {
  ;(globalThis as { __wf8Db?: unknown }).__wf8Db = undefined
})

const CI_ROW = {
  id: 'ci-1',
  platform: 'web_search',
  external_id: 'ext-1',
  url: 'https://example.com/a',
  title: 'AI 创业观察',
  excerpt: '一段市场摘要',
  ai_analysis: { core_viewpoint: 'AI 降本增效' },
  embedding: [0.5, 0.5, 0.5, 0.5],
  fetched_at: '2026-09-19T07:00:00Z',
  expires_at: '2026-09-26T07:00:00Z',
}

describe('getMarketCandidates：S2 出口协议转换（行为保持）', () => {
  it('映射结果与直接映射逐字段一致（title/topic/marketRefs/contentValue）', async () => {
    const { db } = mockDbWithRows([CI_ROW])
    ;(globalThis as { __wf8Db?: unknown }).__wf8Db = db

    const out = await getMarketCandidates(centroid, 4)
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('ci_market')
    expect(out[0].title).toBe('AI 创业观察')
    expect(out[0].topic).toContain('AI 创业观察')
    expect(out[0].marketRefs).toEqual([{ platform: 'web_search', url: 'https://example.com/a' }])
    expect(out[0].contentValue).toBeGreaterThanOrEqual(0.3)
  })

  it('embedding 维度不匹配的行被跳过（既有过滤行为保持）', async () => {
    const { db } = mockDbWithRows([{ ...CI_ROW, embedding: [1, 2] }])
    ;(globalThis as { __wf8Db?: unknown }).__wf8Db = db
    expect(await getMarketCandidates(centroid, 4)).toEqual([])
  })

  it('service client 缺失 → 静默空数组（既有降级保持）', async () => {
    expect(await getMarketCandidates(centroid, 4)).toEqual([])
  })
})

// ── ciSearch：stub 常驻后 noAdapters 估算模式语义保持 ──

describe('ciSearch noAdapters 语义（stub 注册回归）', () => {
  it('仅有 stub 在册（无真实源）→ noAdapters:true，调用方回退估算模式', async () => {
    vi.stubEnv('TAVILY_API_KEY', '')
    vi.resetModules()
    ;(globalThis as { __wf8Db?: unknown }).__wf8Db = { from: vi.fn() } // findFreshItems 查询桩

    const { ciSearch } = await import('../../ci/service')
    const r = await ciSearch({ topic: '测试主题' })
    expect(r.noAdapters).toBe(true)
    expect(r.items).toEqual([])
  })
})
