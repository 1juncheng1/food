// @vitest-environment node
// ↑ 必须：multipart 解析依赖 undici 的 Request，jsdom 环境没有实现
//   （表现为 req.formData() 抛 "Content-Type was not one of ..."）

// ============================================================
// /api/profile/me：社区身份写入（昵称 + 头像）
//
// 重点覆盖「写失败时不能留下垃圾」与「不能接受危险输入」：
//   1. 头像传成功但 metadata 写入失败 → 必须回收刚传的文件（否则留孤儿）
//   2. 外链头像只接受 http(s)，javascript: / data: 一律拒
//   3. 昵称长度、空 body、缺 token、限流都走明确的 4xx，不吞成 500
// ============================================================

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const USER = '11111111-1111-1111-1111-111111111111'

const updateMetaMock = vi.fn()
// 限流：默认放行，个别用例覆写成 { ok: false } 验 429
const rateLimitMock = vi.fn<
  (key: string, limit: number, windowMs: number) => { ok: boolean; retryAfterSec: number }
>()
const invalidateMock = vi.fn()
const cleanupMock = vi.fn()
const uploadMock = vi.fn()
const validateMock = vi.fn()
const getUserMock = vi.fn()

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => ({ auth: { getUser: getUserMock } }),
}))

vi.mock('@/lib/apiAuth', () => ({
  authFailureResponse: () => NextResponse.json({ error: '登录已失效' }, { status: 401 }),
}))

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: (key: string, limit: number, windowMs: number) =>
    rateLimitMock(key, limit, windowMs),
}))

vi.mock('@/lib/postsCache', () => ({
  invalidatePostsBaseCache: () => invalidateMock(),
}))

vi.mock('@/lib/storage', () => ({
  cleanupFile: (...args: unknown[]) => cleanupMock(...args),
  mediaPathFromUrl: () => null,
  uploadAvatarToStorage: (...args: unknown[]) => uploadMock(...args),
  validateAvatarFile: (...args: unknown[]) => validateMock(...args),
}))

// isSafeAvatarUrl 用真实实现（XSS 协议白名单是本文件要验的边界），
// 只把会打网络请求的 updateOwnUserMetadata 换成桩
vi.mock('@/lib/authMetadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/authMetadata')>()
  return {
    ...actual,
    updateOwnUserMetadata: (...args: unknown[]) => updateMetaMock(...args),
  }
})

const AUTHED = {
  data: { user: { id: USER, user_metadata: { display_name: '旧名字' } } },
  error: null,
}

beforeEach(() => {
  updateMetaMock.mockReset()
  rateLimitMock.mockReset().mockReturnValue({ ok: true, retryAfterSec: 0 })
  invalidateMock.mockReset()
  cleanupMock.mockReset()
  uploadMock.mockReset()
  validateMock.mockReset()
  getUserMock.mockReset().mockResolvedValue(AUTHED)
})

async function patch(body: unknown, withToken = true) {
  const mod = await import('./route')
  return mod.PATCH(
    new Request('http://localhost/api/profile/me', {
      method: 'PATCH',
      headers: withToken
        ? { authorization: 'Bearer t', 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
}

async function post(form: FormData, withToken = true) {
  const mod = await import('./route')
  return mod.POST(
    new Request('http://localhost/api/profile/me', {
      method: 'POST',
      headers: withToken ? { authorization: 'Bearer t' } : {},
      body: form,
    })
  )
}

describe('PATCH /api/profile/me：昵称与外链头像', () => {
  it('没有 token → 401', async () => {
    const res = await patch({ displayName: 'x' }, false)
    expect(res.status).toBe(401)
  })

  it('登录失效（getUser 报错）→ 直接回鉴权失败响应', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: 'bad' } })
    const res = await patch({ displayName: 'x' })
    expect(res.status).toBe(401)
  })

  it('昵称为空 / 超长 → 400，且不调用写入', async () => {
    expect((await patch({ displayName: '   ' })).status).toBe(400)
    expect((await patch({ displayName: '字'.repeat(25) })).status).toBe(400)
    expect(updateMetaMock).not.toHaveBeenCalled()
  })

  it('危险协议头像 → 400（javascript: / data: 会被当 URL 执行）', async () => {
    expect((await patch({ avatarUrl: 'javascript:alert(1)' })).status).toBe(400)
    expect((await patch({ avatarUrl: 'data:text/html,<script>' })).status).toBe(400)
    expect(updateMetaMock).not.toHaveBeenCalled()
  })

  it('改昵称成功 → 写入 display_name 并失效公共列表缓存', async () => {
    updateMetaMock.mockResolvedValue({ ok: true, displayName: '阿澄', avatarUrl: null })
    const res = await patch({ displayName: '阿澄' })
    expect(res.status).toBe(200)
    expect(updateMetaMock).toHaveBeenCalledWith('t', { display_name: '阿澄' })
    // 昵称会渲染在 Feed/评论里，公共缓存里的旧作者名必须失效
    expect(invalidateMock).toHaveBeenCalledTimes(1)
    await expect(res.json()).resolves.toMatchObject({ displayName: '阿澄' })
  })

  it('body 无有效字段 → 400', async () => {
    expect((await patch({})).status).toBe(400)
  })

  it('限流命中 → 429（带 Retry-After）', async () => {
    rateLimitMock.mockReturnValue({ ok: false, retryAfterSec: 30 })
    const res = await patch({ displayName: '阿澄' })
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(updateMetaMock).not.toHaveBeenCalled()
  })

  it('写入失败 → 透传服务端状态码与文案', async () => {
    updateMetaMock.mockResolvedValue({ ok: false, status: 401, error: '登录已过期，请重新登录' })
    const res = await patch({ displayName: '阿澄' })
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ error: '登录已过期，请重新登录' })
  })
})

describe('POST /api/profile/me：头像上传', () => {
  it('没有 token → 401', async () => {
    const form = new FormData()
    const res = await post(form, false)
    expect(res.status).toBe(401)
  })

  it('没选文件 → 400，且不上传', async () => {
    validateMock.mockReturnValue({ error: 'no_file' })
    const res = await post(new FormData())
    expect(res.status).toBe(400)
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('上传成功 → 回写 avatar_url 并失效缓存', async () => {
    validateMock.mockReturnValue({ ext: 'png' })
    uploadMock.mockResolvedValue({
      imageUrl: 'https://x/media/a.png',
      fileName: `${USER}/avatar-1.png`,
    })
    updateMetaMock.mockResolvedValue({ ok: true, displayName: '', avatarUrl: 'https://x/media/a.png' })

    const form = new FormData()
    form.append('file', new File(['x'], 'a.png', { type: 'image/png' }))
    const res = await post(form)

    expect(res.status).toBe(200)
    expect(updateMetaMock).toHaveBeenCalledWith('t', { avatar_url: 'https://x/media/a.png' })
    expect(invalidateMock).toHaveBeenCalledTimes(1)
  })

  it('头像传成功但 metadata 写入失败 → 回收刚传的文件（不留孤儿）', async () => {
    validateMock.mockReturnValue({ ext: 'png' })
    uploadMock.mockResolvedValue({
      imageUrl: 'https://x/media/a.png',
      fileName: `${USER}/avatar-1.png`,
    })
    updateMetaMock.mockResolvedValue({ ok: false, status: 500, error: '资料更新失败' })

    const form = new FormData()
    form.append('file', new File(['x'], 'a.png', { type: 'image/png' }))
    const res = await post(form)

    expect(res.status).toBe(500)
    expect(cleanupMock).toHaveBeenCalledWith(expect.anything(), `${USER}/avatar-1.png`)
    expect(invalidateMock).not.toHaveBeenCalled()
  })
})
