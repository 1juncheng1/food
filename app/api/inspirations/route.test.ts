// ============================================================
// GET /api/inspirations —— build 在途状态 + 降级文案诚实化（行为C/E）
//
// 契约：
//   - 所有响应带 building 布尔：该用户存在 status='running' 的 build 时为 true
//     （前端据此显示「正在分析你的第一篇作品…」，配合既有 20s 轮询自动刷新）
//   - 降级卡 reason 不再用答非所问的「大众创作方向」：
//       guest       → 引导登录
//       cold_start  → 告知画像积累中、第一篇创作后即有定制选题
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getUser, getActiveSuggestions, getProfile, getLastBuild, findRunningBuild, runBuild } = vi.hoisted(() => ({
  getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
  getActiveSuggestions: vi.fn().mockResolvedValue([]),
  getProfile: vi.fn().mockResolvedValue({ profile: null }),
  getLastBuild: vi.fn().mockResolvedValue(null),
  findRunningBuild: vi.fn().mockResolvedValue(null),
  runBuild: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/supabaseServer', () => ({
  // cold_start 分支有一次 creator_events count 查询：链上终结节点 await 都得 {count:0}
  createServerClient: () => {
    const zeroCount = { then: (cb: (v: unknown) => unknown) => Promise.resolve({ count: 0, data: [] }).then(cb) }
    // 注意：先建对象再挂方法，不能在字面量里 mockReturnValue(chain)（TDZ）
    const chain: { select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn>; gt: ReturnType<typeof vi.fn> } = {
      select: vi.fn(),
      eq: vi.fn(),
      gt: vi.fn(),
    }
    chain.select.mockReturnValue(chain)
    chain.eq.mockReturnValue(zeroCount)
    chain.gt.mockReturnValue(zeroCount)
    return { auth: { getUser }, from: vi.fn().mockReturnValue(chain) }
  },
}))
vi.mock('@/lib/creative/interest/suggestionRepo', () => ({ getActiveSuggestions }))
vi.mock('@/lib/creative/interest/interestRepo', () => ({ getProfile, getLastBuild, findRunningBuild }))
vi.mock('@/lib/creative/interest/builder', () => ({ runBuild }))
vi.mock('@/lib/creative/interest/fallbackTemplates', () => ({
  getFallbackInspirations: () => [
    { title: '模板选题A', description: '描述A', category: '电影解说' },
    { title: '模板选题B', description: '描述B', category: '短剧解说' },
    { title: '模板选题C', description: '描述C', category: '故事文案' },
  ],
}))

import { GET } from './route'

function get(token?: string) {
  return GET(new Request('http://localhost/api/inspirations', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  getActiveSuggestions.mockResolvedValue([])
  getProfile.mockResolvedValue({ profile: null })
  getLastBuild.mockResolvedValue(null)
  findRunningBuild.mockResolvedValue(null)
  runBuild.mockResolvedValue(null)
})

describe('GET /api/inspirations：building 在途状态', () => {
  it('游客降级响应带 building:false', async () => {
    const res = await get()
    const body = await res.json()
    expect(body.personalized).toBe(false)
    expect(body.degrade_reason).toBe('guest')
    expect(body.building).toBe(false)
  })

  it('登录用户有在途 build（首篇创作后重建中）→ cold_start 且 building:true', async () => {
    findRunningBuild.mockResolvedValue('build-running-1')
    const res = await get('tok')
    const body = await res.json()
    expect(body.degrade_reason).toBe('cold_start')
    expect(body.building).toBe(true)
  })

  it('登录用户无画像且无在途 build → building:false', async () => {
    const res = await get('tok')
    const body = await res.json()
    expect(body.degrade_reason).toBe('cold_start')
    expect(body.building).toBe(false)
  })
})

describe('GET /api/inspirations：降级文案诚实化（行为E）', () => {
  it('游客看到登录引导文案，而非"大众创作方向"', async () => {
    const res = await get()
    const body = await res.json()
    expect(body.inspirations[0].reason).not.toBe('大众创作方向')
    expect(body.inspirations[0].reason).toContain('登录')
  })

  it('冷启动用户看到"第一篇创作后定制"的预期管理文案', async () => {
    const res = await get('tok')
    const body = await res.json()
    expect(body.inspirations[0].reason).not.toBe('大众创作方向')
    expect(body.inspirations[0].reason).toMatch(/第一篇|首篇/)
  })
})
