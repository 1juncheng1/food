// ============================================================
// P1（WF11）：全局热点摄取 globalTrending
// - 日 hash 分区（UTC）
// - reader 读当日未过期 ci_items 并脱敏映射
// - 摄取：在途锁 → 计数闸门 → 6 大类串行 ciSearch（共享日 hash）
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getServiceClient } = vi.hoisted(() => ({
  getServiceClient: vi.fn(),
}))
const { ciSearch } = vi.hoisted(() => ({
  ciSearch: vi.fn(),
}))

vi.mock('./store', () => ({ getServiceClient }))
vi.mock('./service', () => ({ ciSearch }))

import {
  GLOBAL_TRENDING_CATEGORIES,
  GLOBAL_TRENDING_FRESH_MIN,
  globalHashFor,
  getGlobalTrending,
  ingestGlobalTrending,
} from './globalTrending'

const NOW = new Date('2026-09-20T12:00:00Z')
const HASH = 'global:v1:2026-09-20'

/** 组装 ci_items 查询链；limit() 为链尾 thenable */
function mockDb(rows: unknown[] | null) {
  const calls: { eq: unknown[][]; gt: unknown[][]; limit: number[] } = { eq: [], gt: [], limit: [] }
  const terminal = vi.fn().mockResolvedValue({ data: rows, error: null })
  const node: Record<string, unknown> = {}
  node.select = vi.fn(() => node)
  node.eq = vi.fn((col: string, val: unknown) => {
    calls.eq.push([col, val])
    return node
  })
  node.gt = vi.fn((col: string, val: unknown) => {
    calls.gt.push([col, val])
    return node
  })
  node.order = vi.fn(() => node)
  node.limit = vi.fn((n: number) => {
    calls.limit.push(n)
    return terminal()
  })
  const from = vi.fn(() => node)
  return { client: { from } as never, calls, terminal }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('globalHashFor（UTC 日分区）', () => {
  it('格式为 global:v1:YYYY-MM-DD，按 UTC 跨日翻转', () => {
    expect(globalHashFor(new Date('2026-09-20T23:59:59Z'))).toBe('global:v1:2026-09-20')
    expect(globalHashFor(new Date('2026-09-21T00:00:00Z'))).toBe('global:v1:2026-09-21')
  })
})

describe('getGlobalTrending（reader 脱敏读取）', () => {
  it('当日 ci_items 行映射为热点卡：description 取 excerpt，category 取 content_info.topic，不泄露 ai_analysis', async () => {
    const rows = [
      {
        title: 'AI 写作工具新玩法',
        excerpt: '最近创作者都在用它做脚本',
        url: 'https://example.com/a',
        platform: 'web_search',
        content_info: { topic: 'AI工具最新趋势' },
        ai_analysis: { reference_value: '内部字段不该外泄' },
      },
      {
        title: '副业观察',
        excerpt: '',
        url: null,
        platform: 'news',
        content_info: { topic: '副业变现新方向' },
        ai_analysis: { reference_value: '无 excerpt 时的兜底描述' },
      },
    ]
    const { client, calls } = mockDb(rows)
    getServiceClient.mockReturnValue(client)

    const cards = await getGlobalTrending(3, NOW)

    expect(cards).toHaveLength(2)
    expect(cards[0]).toEqual({
      title: 'AI 写作工具新玩法',
      description: '最近创作者都在用它做脚本',
      category: 'AI工具最新趋势',
      url: 'https://example.com/a',
      platform: 'web_search',
    })
    // 无 excerpt 时用 ai_analysis.reference_value 兜底；url 缺失为 null
    expect(cards[1].description).toBe('无 excerpt 时的兜底描述')
    expect(cards[1].url).toBeNull()
    // 卡面不含任何内部字段
    expect(JSON.stringify(cards)).not.toContain('ai_analysis')
    // 查询条件：当日 hash + 未过期 + limit 透传
    expect(calls.eq).toContainEqual(['query_hash', HASH])
    expect(calls.gt[0]?.[0]).toBe('expires_at')
    expect(calls.limit).toContain(3)
  })

  it('未配置 service client / 查询异常 / 空结果时返回空数组（降级不抛）', async () => {
    getServiceClient.mockReturnValueOnce(null)
    expect(await getGlobalTrending(3, NOW)).toEqual([])

    const { client } = mockDb([])
    getServiceClient.mockReturnValueOnce(client)
    expect(await getGlobalTrending(3, NOW)).toEqual([])

    const errNode: Record<string, unknown> = {}
    errNode.select = () => {
      throw new Error('network down')
    }
    getServiceClient.mockReturnValueOnce({ from: () => errNode } as never)
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await getGlobalTrending(3, NOW)).toEqual([])
    spy.mockRestore()
  })
})

describe('ingestGlobalTrending（闸门 + 在途锁 + 串行扇出）', () => {
  it('当日热点已达闸门数量 → skipped，不产生 ciSearch 调用', async () => {
    const enough = Array.from({ length: GLOBAL_TRENDING_FRESH_MIN }, (_, i) => ({ title: `t${i}` }))
    getServiceClient.mockReturnValue(mockDb(enough).client)

    const result = await ingestGlobalTrending(NOW)
    expect(result).toBe('skipped')
    expect(ciSearch).not.toHaveBeenCalled()
  })

  it('库存不足：6 大类串行 ciSearch，全部携带当日 hashOverride；全失败返回 failed 不抛', async () => {
    getServiceClient.mockReturnValue(mockDb([]).client)
    // 串行验证：记录在途峰值
    let inFlight = 0
    let peak = 0
    ciSearch.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return { items: [] }
    })
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await ingestGlobalTrending(NOW)
    expect(result).toBe('failed')
    expect(ciSearch).toHaveBeenCalledTimes(GLOBAL_TRENDING_CATEGORIES.length)
    expect(peak).toBe(1) // 串行而非并发
    for (const call of ciSearch.mock.calls) {
      expect(call[0].hashOverride).toBe(HASH)
    }
    // 大类查询词互不相同且带 maxItems 上限
    const topics = ciSearch.mock.calls.map((c) => (c[0] as { topic: string }).topic)
    expect(new Set(topics).size).toBe(GLOBAL_TRENDING_CATEGORIES.length)
    spy.mockRestore()
  })

  it('库存不足且任一类有结果 → ingested；并发调用只产生一轮（在途锁，第二个 locked）', async () => {
    getServiceClient.mockReturnValue(mockDb([{ title: 'only-one' }]).client)
    ciSearch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10))
      return { items: [{ external_id: 'x1' }] }
    })

    const [a, b] = await Promise.all([ingestGlobalTrending(NOW), ingestGlobalTrending(NOW)])
    expect([a, b].sort()).toEqual(['ingested', 'locked'])
    expect(ciSearch).toHaveBeenCalledTimes(GLOBAL_TRENDING_CATEGORIES.length)
  })
})
