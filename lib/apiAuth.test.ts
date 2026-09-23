import { describe, it, expect } from 'vitest'
import { authFailureResponse } from './apiAuth'

// supabase-js **不会**在网络故障时抛异常，而是把错误作为返回值交给调用方：
// AuthRetryableFetchError(name, status=0, 'fetch failed')。
// 这条测试存在的唯一理由：确保这条区分永远不被抹平。
function transportError(over: { name?: string; status?: number; message?: string } = {}) {
  const e = new Error(over.message ?? 'fetch failed')
  e.name = over.name ?? 'AuthRetryableFetchError'
  Object.assign(e, { status: over.status ?? 0 })
  return e
}

function httpError(status: number) {
  const e = new Error('invalid JWT: signature is invalid')
  e.name = 'AuthApiError'
  Object.assign(e, { status })
  return e
}

describe('authFailureResponse（网络故障必须区分于凭证失效）', () => {
  it('AuthRetryableFetchError → 503，且标记 retryable', async () => {
    const res = authFailureResponse(transportError())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.retryable).toBe(true)
    expect(String(body.error)).toContain('网络')
  })

  it('status=0（请求没能到服务端）→ 503', () => {
    expect(authFailureResponse(transportError({ name: 'WhateverError' })).status).toBe(503)
  })

  it('错误信息含网络关键词 → 503', () => {
    expect(authFailureResponse(new Error('network request failed')).status).toBe(503)
    expect(authFailureResponse(new Error('ETIMEDOUT')).status).toBe(503)
  })

  it('真正的 JWT 失效（AuthApiError 4xx）→ 401', () => {
    // 403 invalid JWT / 401 unauthorized 说明请求到达了服务端，确实是凭证有问题
    expect(authFailureResponse(httpError(403)).status).toBe(401)
    expect(authFailureResponse(httpError(401)).status).toBe(401)
    expect(authFailureResponse(httpError(400)).status).toBe(401)
  })

  it('没有 error 但也没有 user → 401', () => {
    expect(authFailureResponse(null).status).toBe(401)
    expect(authFailureResponse(undefined).status).toBe(401)
  })

  it('回归护栏：任何网络类错误都不得再返回 401', () => {
    const cases = [
      transportError(),
      transportError({ message: 'Failed to fetch' }),
      transportError({ name: 'TypeError', message: 'fetch failed' }),
      new Error('ENOTFOUND'),
      new Error('ECONNRESET'),
    ]
    for (const c of cases) {
      // 401 会让前端判定"没登录"并把用户踢到 /login
      expect(authFailureResponse(c).status).not.toBe(401)
    }
  })
})
