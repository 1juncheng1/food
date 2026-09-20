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

vi.mock('./store', () => ({ findFreshItems, upsertItems, logSearch }))
// 缓存命中路径不触达 adapter；返回空数组即可
vi.mock('./registry', () => ({ getEnabledAdapters: () => [] }))

import { ciSearch, queryHashOf } from './service'

beforeEach(() => {
  vi.clearAllMocks()
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
