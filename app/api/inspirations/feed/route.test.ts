// ============================================================
// GET /api/inspirations/feed —— 分页端点测试（WF11 P2 AC-4/5/6）
//
// 覆盖：
//   - 未登录 → 401
//   - 有 active 卡 → 正常分页
//   - 无 active 卡但有画像 → 全局热点补位
//   - 无画像 → 冷启动全局热点流
//   - 日达 100 张上限 → no_more:true
//   - 库存 ≤8 → fire-and-forget 触发 build
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getUser, getProfile, findRunningBuild, runBuild, getGlobalTrending, getFeedPage, getDailySuggestionCount } = vi.hoisted(() => ({
  getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
  getProfile: vi.fn().mockResolvedValue({ profile: null }),
  findRunningBuild: vi.fn().mockResolvedValue(null),
  runBuild: vi.fn().mockResolvedValue(null),
  getGlobalTrending: vi.fn().mockResolvedValue([]),
  getFeedPage: vi.fn().mockResolvedValue({ cards: [], next_cursor: null, no_more: false, remaining: 0 }),
  getDailySuggestionCount: vi.fn().mockResolvedValue(0),
}))

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => ({ auth: { getUser } }),
}))
vi.mock('@/lib/creative/interest/interestRepo', () => ({ getProfile, findRunningBuild }))
vi.mock('@/lib/creative/interest/builder', () => ({ runBuild }))
vi.mock('@/lib/ci/globalTrending', () => ({ getGlobalTrending }))
vi.mock('@/lib/creative/interest/feedRepo', () => ({ getFeedPage, getDailySuggestionCount, FEED_DAILY_CAP: 100, FEED_TOPUP_THRESHOLD: 8 }))
vi.mock('@/lib/creative/interest/suggestionRepo', () => ({ SuggestionRow: {} }))
vi.mock('@/lib/creative/interest/reasonAi', () => ({
  buildReasonText: vi.fn().mockReturnValue('基于你的创作兴趣推荐'),
}))

import { GET } from './route'

function makeRequest(params?: { cursor?: string; limit?: string; token?: string }) {
  const url = new URL('http://localhost/api/inspirations/feed')
  if (params?.cursor) url.searchParams.set('cursor', params.cursor)
  if (params?.limit) url.searchParams.set('limit', params.limit)
  return new Request(url, {
    headers: params?.token ? { authorization: `Bearer ${params.token}` } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  getProfile.mockResolvedValue({ profile: null })
  findRunningBuild.mockResolvedValue(null)
  runBuild.mockResolvedValue(null)
  getGlobalTrending.mockResolvedValue([])
  getFeedPage.mockResolvedValue({ cards: [], next_cursor: null, no_more: false, remaining: 0 })
  getDailySuggestionCount.mockResolvedValue(0)
})

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── 鉴权 ──

describe('鉴权', () => {
  it('未登录 → 401', async () => {
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('token 失效 → 401', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: 'invalid' })
    const res = await GET(makeRequest({ token: 'expired' }))
    expect(res.status).toBe(401)
  })
})

// ── 冷启动 ──

describe('冷启动（无画像）', () => {
  it('无画像 → 返回全局热点流 fallback_source=trending', async () => {
    getGlobalTrending.mockResolvedValue([
      { title: '热点A', description: '描述A', category: 'AI工具' },
      { title: '热点B', description: '描述B', category: '副业' },
    ])
    const res = await GET(makeRequest({ token: 'tok' }))
    const body = await res.json()
    expect(body.fallback_source).toBe('trending')
    expect(body.cards).toHaveLength(2)
    expect(body.cards[0].title).toBe('热点A')
    expect(body.cards[0].cluster_code).toBe('global_trending')
    expect(body.no_more).toBe(true) // 热点流不分页
  })

  it('无画像且无热点 → 空数组', async () => {
    const res = await GET(makeRequest({ token: 'tok' }))
    const body = await res.json()
    expect(body.cards).toHaveLength(0)
    expect(body.fallback_source).toBe('trending')
  })
})

// ── 有画像无队列 ──

describe('有画像但队列空', () => {
  it('有画像无 active 卡 → 返回全局热点补位', async () => {
    getProfile.mockResolvedValue({ profile: { build_id: 'b1' } })
    getFeedPage.mockResolvedValue({ cards: [], next_cursor: null, no_more: false, remaining: 0 })
    getGlobalTrending.mockResolvedValue([{ title: '热点1', description: 'desc', category: 'AI' }])
    const res = await GET(makeRequest({ token: 'tok' }))
    const body = await res.json()
    expect(body.fallback_source).toBe('trending')
    expect(body.cards).toHaveLength(1)
    expect(body.no_more).toBe(false) // 画像在，build 后会有新卡
  })
})

// ── 正常分页 ──

describe('正常分页', () => {
  it('有 active 卡 → 返回分页结果', async () => {
    getProfile.mockResolvedValue({ profile: { build_id: 'b1' } })
    getFeedPage.mockResolvedValue({
      cards: [
        {
          id: 's1', cluster_code: 'c1', slot: 'core_gap', source: 'exploration',
          title: '选题1', description: '描述1', topic: '话题1', form_hint: 'AI工具',
          score: 0.9, score_breakdown: {}, evidence: { cross_exploration: true },
          core_question: null, why_recommend: null, creation_angle: null,
          related_knowledge: null, reason_source: 'ai',
        } as never,
      ],
      next_cursor: 'abc',
      no_more: false,
      remaining: 15,
    })
    const res = await GET(makeRequest({ token: 'tok' }))
    const body = await res.json()
    expect(body.cards).toHaveLength(1)
    expect(body.cards[0].title).toBe('选题1')
    expect(body.cards[0].cross_exploration).toBe(true)
    expect(body.cards[0].rec_id).toBe('s1')
    expect(body.next_cursor).toBe('abc')
    expect(body.no_more).toBe(false)
  })
})

// ── 补卡触发（AC-5）──

describe('补卡触发', () => {
  it('库存 ≤8 且无在途 build → fire-and-forget runBuild', async () => {
    getProfile.mockResolvedValue({ profile: { build_id: 'b1' } })
    getFeedPage.mockResolvedValue({
      cards: [],
      next_cursor: null,
      no_more: false,
      remaining: 5, // ≤ FEED_TOPUP_THRESHOLD
    })
    await GET(makeRequest({ token: 'tok' }))
    await flushAsync()
    expect(runBuild).toHaveBeenCalledTimes(1)
  })

  it('库存 >8 不触发 build', async () => {
    getProfile.mockResolvedValue({ profile: { build_id: 'b1' } })
    getFeedPage.mockResolvedValue({
      cards: [],
      next_cursor: null,
      no_more: false,
      remaining: 20, // > 8
    })
    await GET(makeRequest({ token: 'tok' }))
    await flushAsync()
    expect(runBuild).not.toHaveBeenCalled()
  })

  it('有在途 build 时不重复触发', async () => {
    getProfile.mockResolvedValue({ profile: { build_id: 'b1' } })
    findRunningBuild.mockResolvedValue('running-1')
    getFeedPage.mockResolvedValue({
      cards: [], next_cursor: null, no_more: false, remaining: 3,
    })
    await GET(makeRequest({ token: 'tok' }))
    await flushAsync()
    expect(runBuild).not.toHaveBeenCalled()
  })
})

// ── 日上限（AC-6）──

describe('日 100 张上限', () => {
  it('达上限 → no_more:true 且不触发 build', async () => {
    getDailySuggestionCount.mockResolvedValue(100)
    const res = await GET(makeRequest({ token: 'tok' }))
    const body = await res.json()
    expect(body.no_more).toBe(true)
    expect(body.cards).toHaveLength(0)
    await flushAsync()
    expect(runBuild).not.toHaveBeenCalled()
    expect(getFeedPage).not.toHaveBeenCalled()
  })

  it('未达上限正常处理', async () => {
    getDailySuggestionCount.mockResolvedValue(50)
    getProfile.mockResolvedValue({ profile: { build_id: 'b1' } })
    getFeedPage.mockResolvedValue({
      cards: [], next_cursor: null, no_more: false, remaining: 20,
    })
    const res = await GET(makeRequest({ token: 'tok' }))
    const body = await res.json()
    expect(body.no_more).toBe(false)
    expect(getFeedPage).toHaveBeenCalled()
  })
})
