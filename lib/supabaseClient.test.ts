// ============================================================
// lib/supabaseClient —— getValidSession() 的会话取用契约
//
// 这个文件锁的是一个间歇性线上问题的修复：token 还没过期，却因为
// 「一次刷新失败」被判成未登录，而调用方普遍写成
//     if (!session) router.replace('/login')
// 于是用户被整页踢到登录页。
//
// 以下两条行为必须守住，否则问题会以
// 「有时候莫名掉登录」的形式回归，且极难复现：
//   ① 刷新失败 ⟹ 回退到仍未过期的旧 token，而不是 null
//   ② 并发调用共享同一次刷新，不能各自发起（会互相作废 refresh_token）
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@supabase/supabase-js'

// supabaseClient 在模块顶层读取环境变量并校验缺失，必须在 import 之前备好。
// vi.hoisted 会提升到最顶部，正好满足这个时序要求。
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

const { getSession, refreshSession } = vi.hoisted(() => ({
  getSession: vi.fn(),
  refreshSession: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getSession, refreshSession } }),
}))

import { getValidSession } from './supabaseClient'

/** 构造一个 expiresInSec 秒后过期的 session */
function session(expiresInSec: number, over: Partial<Session> = {}): Session {
  return {
    access_token: 'old-token',
    refresh_token: 'refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
    expires_in: expiresInSec,
    token_type: 'bearer',
    user: { id: 'user-1' } as never,
    ...over,
  } as Session
}

const serverFailure = { data: { session: null }, error: { message: 'invalid_refresh_token' } }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getValidSession：未接近过期', () => {
  it('剩余有效期充足 → 原样返回，不发起刷新', async () => {
    const s = session(3600)
    getSession.mockResolvedValue({ data: { session: s } })

    await expect(getValidSession()).resolves.toBe(s)
    expect(refreshSession).not.toHaveBeenCalled()
  })
})

describe('getValidSession：接近过期（120s 窗口内）', () => {
  it('刷新成功 → 返回新 session', async () => {
    getSession.mockResolvedValue({ data: { session: session(60) } })
    const fresh = session(3600, { access_token: 'new-token' })
    refreshSession.mockResolvedValue({ data: { session: fresh }, error: null })

    const got = await getValidSession()
    expect(got?.access_token).toBe('new-token')
    expect(refreshSession).toHaveBeenCalledTimes(1)
  })

  it('刷新失败但旧 token 未过期 → 回退旧 session，绝不判未登录', async () => {
    // 这是本次修复的核心：一次网络抖动/并发冲突不应让用户掉线
    const s = session(90)
    getSession.mockResolvedValue({ data: { session: s } })
    refreshSession.mockResolvedValue(serverFailure)

    const got = await getValidSession()
    expect(got).toBe(s)
    expect(got?.access_token).toBe('old-token')
  })

  it('刷新抛异常（网络层）→ 同样回退旧 session', async () => {
    const s = session(90)
    getSession.mockResolvedValue({ data: { session: s } })
    refreshSession.mockRejectedValue(new Error('network down'))

    await expect(getValidSession()).resolves.toBe(s)
  })

  it('token 确实已过期且刷新失败 → 才返回 null', async () => {
    getSession.mockResolvedValue({ data: { session: session(-10) } })
    refreshSession.mockResolvedValue(serverFailure)

    await expect(getValidSession()).resolves.toBeNull()
  })
})

describe('getValidSession：并发调用', () => {
  it('并发多个调用点 → 只发起一次刷新，结果共享', async () => {
    getSession.mockResolvedValue({ data: { session: session(60) } })
    const fresh = session(3600, { access_token: 'new-token' })
    refreshSession.mockResolvedValue({ data: { session: fresh }, error: null })

    const results = await Promise.all([
      getValidSession(),
      getValidSession(),
      getValidSession(),
    ])

    // Supabase 默认 refresh token rotation：各自发起会互相作废，
    // 只有一个成功、其余拿到 invalid_refresh_token
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(results.map((r) => r?.access_token)).toEqual([
      'new-token',
      'new-token',
      'new-token',
    ])
  })

  it('刷新失败时的并发调用 → 一致地回退到旧 session，不会出现部分 null', async () => {
    const s = session(90)
    getSession.mockResolvedValue({ data: { session: s } })
    refreshSession.mockResolvedValue(serverFailure)

    const results = await Promise.all([
      getValidSession(),
      getValidSession(),
      getValidSession(),
    ])

    // 关键：不能有任何一个调用方拿到 null，否则那一处就会把用户踢走
    expect(results.every((r) => r === s)).toBe(true)
    expect(refreshSession).toHaveBeenCalledTimes(1)
  })

  it('刷新结束后 in-flight 标记复位，下一次调用会重新刷新', async () => {
    getSession.mockResolvedValue({ data: { session: session(60) } })
    refreshSession.mockResolvedValue(serverFailure)

    await getValidSession()
    await getValidSession()

    // 第一次的 in-flight 若没复位，第二次会被"记住"的结果污染；
    // 这里两次各发一次刷新，证明标记已清掉
    expect(refreshSession).toHaveBeenCalledTimes(2)
  })
})

describe('getValidSession：无会话', () => {
  it('本地没有 session → null 且不再刷新', async () => {
    getSession.mockResolvedValue({ data: { session: null } })

    await expect(getValidSession()).resolves.toBeNull()
    expect(refreshSession).not.toHaveBeenCalled()
  })
})
