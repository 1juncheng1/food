// ============================================================
// P1（WF11）：ciSearch 的 hashOverride 行为
// 全局热点摄取需要让多个大类查询共享同一个「global:v1:<date>」缓存分区，
// 而不是按 topic 各算各的 query hash。
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findFreshItems, upsertItems, logSearch } = vi.hoisted(() => ({
  findFreshItems: vi.fn(),
  upsertItems: vi.fn(),
  logSearch: vi.fn(),
}))

const { getEnabledAdapters } = vi.hoisted(() => ({ getEnabledAdapters: vi.fn() }))
const { enrichItems } = vi.hoisted(() => ({ enrichItems: vi.fn() }))
const { generateEmbedding } = vi.hoisted(() => ({ generateEmbedding: vi.fn() }))

vi.mock('./store', () => ({ findFreshItems, upsertItems, logSearch }))
// 默认无 adapter（缓存命中路径不触达 adapter）；需要扇出的用例自行注入
vi.mock('./registry', () => ({ getEnabledAdapters }))
// 富化与向量是外部调用，测试内替换为透传 / 固定值
vi.mock('./enrich', () => ({ enrichItems }))
vi.mock('../storage', () => ({ generateEmbedding }))

import { ciSearch, queryHashOf } from './service'

beforeEach(() => {
  vi.clearAllMocks()
  getEnabledAdapters.mockReturnValue([])
  enrichItems.mockImplementation(async (items: unknown[]) => items)
  upsertItems.mockResolvedValue(undefined)
})

describe('ciSearch hashOverride（P1 全局热点分区）', () => {
  it('传入 hashOverride 时，缓存查询使用 override 而非 topic 计算 hash', async () => {
    findFreshItems.mockResolvedValue(Array.from({ length: 6 }, (_, i) => ({ external_id: `x${i}` })))

    await ciSearch({ topic: 'AI工具最新趋势', hashOverride: 'global:v1:2026-09-20' })

    expect(findFreshItems).toHaveBeenCalledWith('global:v1:2026-09-20')
  })

  it('不传 hashOverride 时，沿用 topic+domain 计算 hash（旧行为不回归）', async () => {
    findFreshItems.mockResolvedValue([])

    await ciSearch({ topic: '摆摊卖小吃怎么起步', content_domain: '商业' })

    const expected = queryHashOf('摆摊卖小吃怎么起步', '商业')
    expect(findFreshItems).toHaveBeenCalledWith(expected)
    // 显式与 override 形态区分，防止实现误把所有查询都当全局
    expect(expected).not.toBe('global:v1:2026-09-20')
  })
})

// ── WFP1：落库前补算语义向量 ──
// 背景：ci_items.embedding 自 WF0 建列以来从未写入（store.toRow 漏列），
// S2 市场候选与 Feed 兴趣热点补位的相关性排序因此全部落空。修复点就是
// "落库前补算"，所以这里直接断言落库入参带上了向量。
describe('ciSearch 落库补算语义向量（WFP1）', () => {
  function fakeAdapter() {
    return {
      id: 'web_search',
      capabilities: { metrics: [], publishedAt: true, comments: false },
      async search() {
        return {
          items: [
            {
              external_id: 'e1',
              title: 'AI 写作工具新玩法',
              excerpt: '最近创作者都在用它做脚本',
              url: null,
              platform: 'web_search',
            },
          ],
        }
      },
    } as never
  }

  it('落库条目带 1024 维 embedding；补算与落库不阻塞 items 返回', async () => {
    getEnabledAdapters.mockReturnValue([fakeAdapter()])
    findFreshItems.mockResolvedValue([])
    generateEmbedding.mockResolvedValue(new Array(1024).fill(0.01))

    const result = await ciSearch({ topic: 'AI工具最新趋势', hashOverride: 'global:v1:2026-10-05' })
    expect(result.items.length).toBe(1)

    // 补算 + 落库是 fire-and-forget，推进一轮宏任务等它完成
    await new Promise((r) => setTimeout(r, 0))
    expect(generateEmbedding).toHaveBeenCalledTimes(1)
    const saved = upsertItems.mock.calls[0]?.[0] as Array<{ embedding?: number[] }> | undefined
    expect(saved?.[0]?.embedding?.length).toBe(1024)
  })

  it('向量补算失败静默：items 照常返回且仍落库（缺向量只降级排序，不丢数据）', async () => {
    getEnabledAdapters.mockReturnValue([fakeAdapter()])
    findFreshItems.mockResolvedValue([])
    generateEmbedding.mockRejectedValue(new Error('embedding timeout'))

    const result = await ciSearch({ topic: 'AI工具最新趋势', hashOverride: 'global:v1:2026-10-06' })
    expect(result.items.length).toBe(1)

    await new Promise((r) => setTimeout(r, 0))
    expect(upsertItems).toHaveBeenCalled()
    const saved = upsertItems.mock.calls[0]?.[0] as Array<{ embedding?: number[] }> | undefined
    expect(saved?.[0]?.embedding).toBeUndefined()
  })
})
