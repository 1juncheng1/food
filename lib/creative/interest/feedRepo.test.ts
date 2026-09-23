// ============================================================
// feedRepo.test.ts —— 游标分页纯读层单元测试（WF11 P2 AC-4）
//
// 覆盖：
//   - 游标编码/解码（正常/非法值）
//   - 分页逻辑（首页/翻页/到末尾）
//   - 当日已 dismiss/已曝光的卡被排除
//   - no_more 由 route 层控制（feedRepo 默认 false）
//   - 日出卡计数
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeCursor,
  decodeCursor,
  getFeedPage,
  getDailySuggestionCount,
  getDailyServedCount,
  applyExploreQuota,
  FEED_DAILY_CAP,
  FEED_TOPUP_THRESHOLD,
  EXPLORE_QUOTA_PER_10,
} from './feedRepo'
import type { SuggestionRow } from './suggestionRepo'

// ── mock 数据 ──

const mockRows: SuggestionRow[] = []
const mockExcluded: string[] = []
const mockDailyCount = { value: 0 }

/**
 * 创建 mock supabase client。
 * 用 thenable 模式（同 route.test.ts）：链上所有方法返回 chain，
 * chain.then() 是终结节点，await 时触发。
 */
function makeMockSupabase() {
  // interest_suggestions 终结值：同时含 data 和 count，各取所需
  const sugTerminal = { data: mockRows, count: mockDailyCount.value, error: null }
  // creator_events 终结值：排除 ID 列表
  const excludedData = mockExcluded.map((id) => ({ target_id: id }))
  const evTerminal = { data: excludedData, error: null }

  // 通用链式 builder：所有方法返回 chain 自身，then 是终结
  function makeChain(terminal: unknown) {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {}
    // 先建空对象（避免 TDZ），再逐属性赋值
    chain.select = vi.fn().mockReturnValue(chain)
    chain.eq = vi.fn().mockReturnValue(chain)
    chain.in = vi.fn().mockReturnValue(chain)
    chain.gte = vi.fn().mockReturnValue(chain)
    chain.not = vi.fn().mockReturnValue(chain)
    chain.order = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockReturnValue(chain)
    // thenable：await chain 时触发，返回终端值
    chain.then = vi.fn((resolve: (v: unknown) => unknown) =>
      Promise.resolve(terminal).then(resolve)
    )
    return chain
  }

  const sugChain = makeChain(sugTerminal)
  const evChain = makeChain(evTerminal)

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'creator_events') return evChain
      return sugChain // interest_suggestions
    }),
  }
}

beforeEach(() => {
  mockRows.length = 0
  mockExcluded.length = 0
  mockDailyCount.value = 0
})

// ── 游标编码/解码 ──

describe('encodeCursor / decodeCursor', () => {
  it('编码后解码还原原值', () => {
    const cursor = encodeCursor(0.85, 'abc-123')
    const decoded = decodeCursor(cursor)
    expect(decoded).toEqual({ s: 0.85, i: 'abc-123' })
  })

  it('非法游标返回 null', () => {
    expect(decodeCursor('not-valid-base64!!!')).toBeNull()
  })

  it('缺少字段返回 null', () => {
    const bad = Buffer.from(JSON.stringify({ s: 1 }), 'utf-8').toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })
})

// ── getFeedPage ──

describe('getFeedPage', () => {
  it('空库存返回空页', async () => {
    const supabase = makeMockSupabase()
    const result = await getFeedPage(supabase as never, 'user-1', { limit: 10 })
    expect(result.cards).toHaveLength(0)
    expect(result.next_cursor).toBeNull()
    expect(result.no_more).toBe(false)
    expect(result.remaining).toBe(0)
  })

  it('单页（< limit）返回全部卡且无 next_cursor', async () => {
    mockRows.push(
      { id: 'a', score: 0.9, title: 'A' } as unknown as SuggestionRow,
      { id: 'b', score: 0.8, title: 'B' } as unknown as SuggestionRow,
    )
    const supabase = makeMockSupabase()
    const result = await getFeedPage(supabase as never, 'user-1', { limit: 10 })
    expect(result.cards).toHaveLength(2)
    expect(result.next_cursor).toBeNull()
    expect(result.remaining).toBe(2)
  })

  it('多页：首页返回 limit 条 + next_cursor', async () => {
    for (let i = 0; i < 25; i++) {
      mockRows.push({
        id: `card-${i}`,
        score: 1 - i * 0.01,
        title: `Card ${i}`,
      } as unknown as SuggestionRow)
    }
    const supabase = makeMockSupabase()
    const p1 = await getFeedPage(supabase as never, 'user-1', { limit: 10 })
    expect(p1.cards).toHaveLength(10)
    expect(p1.next_cursor).not.toBeNull()
    expect(p1.remaining).toBe(25)
  })

  it('翻页无重复无遗漏（25 张 / limit=10 → 10+10+5）', async () => {
    for (let i = 0; i < 25; i++) {
      mockRows.push({
        id: `c-${i}`,
        score: 1 - i * 0.01,
        title: `C${i}`,
      } as unknown as SuggestionRow)
    }
    const supabase = makeMockSupabase()
    const allIds: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const r = await getFeedPage(supabase as never, 'user-1', { limit: 10, cursor })
      allIds.push(...r.cards.map((c) => c.id))
      if (!r.next_cursor) break
      cursor = r.next_cursor
    }
    expect(allIds).toHaveLength(25)
    expect(new Set(allIds).size).toBe(25)
  })

  it('排除当日已 dismiss 的卡', async () => {
    mockRows.push(
      { id: 'a', score: 0.9, title: 'A' } as unknown as SuggestionRow,
      { id: 'b', score: 0.8, title: 'B' } as unknown as SuggestionRow,
      { id: 'c', score: 0.7, title: 'C' } as unknown as SuggestionRow,
    )
    mockExcluded.push('b')
    const supabase = makeMockSupabase()
    const result = await getFeedPage(supabase as never, 'user-1', { limit: 10 })
    expect(result.cards.map((c) => c.id)).toEqual(['a', 'c'])
    expect(result.remaining).toBe(2)
  })

  it('排除当日已曝光的卡', async () => {
    mockRows.push(
      { id: 'a', score: 0.9, title: 'A' } as unknown as SuggestionRow,
      { id: 'b', score: 0.8, title: 'B' } as unknown as SuggestionRow,
    )
    mockExcluded.push('a')
    const supabase = makeMockSupabase()
    const result = await getFeedPage(supabase as never, 'user-1', { limit: 10 })
    expect(result.cards.map((c) => c.id)).toEqual(['b'])
  })

  it('非法游标从头开始', async () => {
    mockRows.push(
      { id: 'a', score: 0.9, title: 'A' } as unknown as SuggestionRow,
    )
    const supabase = makeMockSupabase()
    const result = await getFeedPage(supabase as never, 'user-1', { limit: 10, cursor: 'invalid' })
    expect(result.cards).toHaveLength(1)
  })
})

// ── getDailySuggestionCount ──

describe('getDailySuggestionCount', () => {
  it('返回当日计数', async () => {
    mockDailyCount.value = 42
    const supabase = makeMockSupabase()
    const count = await getDailySuggestionCount(supabase as never, 'user-1')
    expect(count).toBe(42)
  })

  it('查询出错返回 0', async () => {
    // 构造一个返回 error 的 mock
    const chain: Record<string, ReturnType<typeof vi.fn>> = {}
    chain.select = vi.fn().mockReturnValue(chain)
    chain.eq = vi.fn().mockReturnValue(chain)
    chain.gte = vi.fn().mockReturnValue(chain)
    chain.then = vi.fn((resolve: (v: unknown) => unknown) =>
      Promise.resolve({ count: 0, error: { message: 'DB error' } }).then(resolve)
    )
    const supabase = {
      auth: { getUser: vi.fn() },
      from: vi.fn().mockReturnValue(chain),
    }
    const count = await getDailySuggestionCount(supabase as never, 'user-1')
    expect(count).toBe(0)
  })
})

// ── getDailyServedCount（WF12：日上限口径从"生成量"改为"已出卡数"）──

describe('getDailyServedCount', () => {
  function makeServedChain(terminal: unknown) {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {}
    chain.select = vi.fn().mockReturnValue(chain)
    chain.eq = vi.fn().mockReturnValue(chain)
    chain.gte = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockReturnValue(chain)
    chain.then = vi.fn((resolve: (v: unknown) => unknown) =>
      Promise.resolve(terminal).then(resolve)
    )
    return chain
  }

  it('同一张卡多次曝光只计一次（按 target_id 去重）', async () => {
    const chain = makeServedChain({
      data: [
        { target_id: 'r1' },
        { target_id: 'r1' },
        { target_id: 'r2' },
        { target_id: null },
      ],
      error: null,
    })
    const supabase = { auth: { getUser: vi.fn() }, from: vi.fn().mockReturnValue(chain) }
    const n = await getDailyServedCount(supabase as never, 'user-1')
    expect(n).toBe(2)
  })

  it('查询出错返回 0（降级为不限制，成本由补货最小间隔兜底）', async () => {
    const chain = makeServedChain({ data: null, error: { message: 'DB error' } })
    const supabase = { auth: { getUser: vi.fn() }, from: vi.fn().mockReturnValue(chain) }
    const n = await getDailyServedCount(supabase as never, 'user-1')
    expect(n).toBe(0)
  })
})

// ── 常量 ──

describe('常量', () => {
  it('FEED_DAILY_CAP = 100', () => {
    expect(FEED_DAILY_CAP).toBe(100)
  })
  it('FEED_TOPUP_THRESHOLD = 8', () => {
    expect(FEED_TOPUP_THRESHOLD).toBe(8)
  })
  it('EXPLORE_QUOTA_PER_10 = 2', () => {
    expect(EXPLORE_QUOTA_PER_10).toBe(2)
  })
})

// ── applyExploreQuota（AC-10）──

describe('applyExploreQuota', () => {
  type TestRow = { slot: string; score: number; id: string }

  function makeRows(nCore: number, nExplore: number): TestRow[] {
    const rows: TestRow[] = []
    for (let i = 0; i < nCore; i++) {
      rows.push({ slot: 'core_gap', score: 1 - i * 0.01, id: `core-${i}` })
    }
    for (let i = 0; i < nExplore; i++) {
      rows.push({ slot: 'exploration', score: 0.5 - i * 0.01, id: `exp-${i}` })
    }
    // 已按 score DESC 排好
    return rows.sort((a, b) => b.score - a.score)
  }

  it('空数组原样返回', () => {
    expect(applyExploreQuota([])).toEqual([])
  })

  it('20 张（15 core + 5 exploration）limit=10 → 首 10 张至少 2 张 exploration', () => {
    const rows = makeRows(15, 5)
    const result = applyExploreQuota(rows)
    const first10 = result.slice(0, 10)
    const exploreCount = first10.filter((r) => r.slot === 'exploration').length
    expect(exploreCount).toBeGreaterThanOrEqual(2)
  })

  it('10 张（8 core + 2 exploration）→ 恰好 2 张 exploration', () => {
    const rows = makeRows(8, 2)
    const result = applyExploreQuota(rows)
    expect(result).toHaveLength(10)
    const exploreCount = result.filter((r) => r.slot === 'exploration').length
    expect(exploreCount).toBe(2)
    // exploration 在窗口位置 8、9
    expect(result[8].slot).toBe('exploration')
    expect(result[9].slot).toBe('exploration')
  })

  it('无 exploration → 全部 nonExploration，不造水卡', () => {
    const rows = makeRows(10, 0)
    const result = applyExploreQuota(rows)
    expect(result).toHaveLength(10)
    expect(result.every((r) => r.slot !== 'exploration')).toBe(true)
  })

  it('全 exploration → 全部保留', () => {
    const rows = makeRows(0, 10)
    const result = applyExploreQuota(rows)
    expect(result).toHaveLength(10)
    expect(result.every((r) => r.slot === 'exploration')).toBe(true)
  })

  it('30 张（20 core + 10 exploration）→ 每 10 张窗口 ≥2 exploration', () => {
    const rows = makeRows(20, 10)
    const result = applyExploreQuota(rows)
    for (let w = 0; w < 3; w++) {
      const window = result.slice(w * 10, (w + 1) * 10)
      const exploreCount = window.filter((r) => r.slot === 'exploration').length
      expect(exploreCount).toBeGreaterThanOrEqual(2)
    }
  })

  it('exploration 不足 2 张时全部放入，不造水卡', () => {
    const rows = makeRows(20, 1)
    const result = applyExploreQuota(rows)
    const exploreCount = result.filter((r) => r.slot === 'exploration').length
    expect(exploreCount).toBe(1) // 只 1 张，全放入
    expect(result).toHaveLength(21)
  })

  it('所有输入行都在结果中（无丢失）', () => {
    const rows = makeRows(15, 5)
    const result = applyExploreQuota(rows)
    const inputIds = new Set(rows.map((r) => r.id))
    const outputIds = new Set(result.map((r) => r.id))
    expect(result.length).toBe(rows.length)
    expect(outputIds.size).toBe(inputIds.size)
  })
})
