// ============================================================
// POST /api/materials/retrieve —— AC-7 鉴权/参数校验/限流
//
// 检索内部逻辑由 lib/material 单测覆盖；此处只验证 HTTP 边界：
//   401（无 token/用户无效）、400（topic/reasonMode/selectedMaterialIds）、
//   200（正常）、429（llm 第 6 次 + Retry-After）
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getUser, retrieveMaterialsMock } = vi.hoisted(() => ({
  getUser: vi.fn(),
  retrieveMaterialsMock: vi.fn(),
}))

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => ({ auth: { getUser } }),
}))

vi.mock('@/lib/material/retrieval', () => ({
  retrieveMaterials: retrieveMaterialsMock,
  MAX_SELECTED: 10,
}))

import { POST } from './route'

function post(body: unknown, token?: string, uid = 'user-1') {
  getUser.mockResolvedValue({ data: { user: { id: uid } }, error: null })
  return doPost(body, token)
}

function doPost(body: unknown, token?: string) {
  return POST(
    new Request('http://localhost/api/materials/retrieve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  retrieveMaterialsMock.mockResolvedValue({
    materials: [],
    meta: {
      degraded: null,
      recalledCandidateCount: 0,
      missingSelectedIds: [],
      reasonMode: 'template',
      threshold: 0.55,
    },
  })
})

describe('POST /api/materials/retrieve：鉴权', () => {
  it('无 Authorization → 401', async () => {
    const res = await POST(
      new Request('http://localhost/api/materials/retrieve', {
        method: 'POST',
        body: JSON.stringify({ currentTopic: 'x' }),
      })
    )
    expect(res.status).toBe(401)
    expect(retrieveMaterialsMock).not.toHaveBeenCalled()
  })

  it('getUser 返回 error → 401', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } })
    const res = await doPost({ currentTopic: 'x' }, 'tok')
    expect(res.status).toBe(401)
  })
})

describe('POST /api/materials/retrieve：参数校验', () => {
  it('currentTopic 空串/非字符串 → 400', async () => {
    expect((await post({ currentTopic: '   ' }, 'tok')).status).toBe(400)
    expect((await post({ currentTopic: 123 }, 'tok')).status).toBe(400)
    expect((await post({}, 'tok')).status).toBe(400)
  })

  it("reasonMode 非 template|llm → 400", async () => {
    expect((await post({ currentTopic: '创业', reasonMode: 'bad' }, 'tok')).status).toBe(400)
  })

  it('selectedMaterialIds 含非字符串 → 400', async () => {
    expect(
      (await post({ currentTopic: '创业', selectedMaterialIds: ['ok', 123] }, 'tok')).status
    ).toBe(400)
    expect(
      (await post({ currentTopic: '创业', selectedMaterialIds: 'no' }, 'tok')).status
    ).toBe(400)
  })

  it('selectedMaterialIds 超过 10 个 → 400', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `id${i}`)
    expect((await post({ currentTopic: '创业', selectedMaterialIds: ids }, 'tok')).status).toBe(400)
  })

  it('非法 JSON body → 400', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u' } }, error: null })
    const res = await POST(
      new Request('http://localhost/api/materials/retrieve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer tok' },
        body: 'not-json',
      })
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/materials/retrieve：正常路径', () => {
  it('合法 template 请求 → 200，入参透传给 retrieveMaterials，meta 回传', async () => {
    const res = await post(
      {
        currentTopic: '  创业公司增长  ',
        currentIntent: '案例引用',
        selectedMaterialIds: ['m1'],
      },
      'tok'
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.threshold).toBe(0.55)
    expect(body.meta.reasonMode).toBe('template')
    expect(retrieveMaterialsMock).toHaveBeenCalledTimes(1)
    const [client, input, opts] = retrieveMaterialsMock.mock.calls[0]
    expect(input).toMatchObject({
      userId: 'user-1',
      currentTopic: '创业公司增长',
      currentIntent: '案例引用',
      selectedMaterialIds: ['m1'],
    })
    expect(opts).toEqual({ reasonMode: 'template' })
    expect(client).toBeTruthy()
  })

  it('reasonMode 默认 template；省略可选字段不报错', async () => {
    const res = await post({ currentTopic: '创业' }, 'tok', 'user-default')
    expect(res.status).toBe(200)
    const opts = retrieveMaterialsMock.mock.calls[0][2]
    expect(opts.reasonMode).toBe('template')
  })
})

describe('POST /api/materials/retrieve：限流（AC-7）', () => {
  it('llm 模式第 6 次请求 → 429 且带 Retry-After', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await post({ currentTopic: '创业', reasonMode: 'llm' }, 'tok', 'user-rl-llm')
      expect(res.status).toBe(200)
    }
    const sixth = await post({ currentTopic: '创业', reasonMode: 'llm' }, 'tok', 'user-rl-llm')
    expect(sixth.status).toBe(429)
    expect(sixth.headers.get('Retry-After')).toBeTruthy()
    // 被限流后不应触发检索
    expect(retrieveMaterialsMock).toHaveBeenCalledTimes(5)
  })

  it('template 模式 10/min：第 11 次 → 429', async () => {
    for (let i = 1; i <= 10; i++) {
      const res = await post({ currentTopic: '创业' }, 'tok', 'user-rl-tpl')
      expect(res.status).toBe(200)
    }
    expect((await post({ currentTopic: '创业' }, 'tok', 'user-rl-tpl')).status).toBe(429)
  })

  it('llm 与 template 使用独立限流桶', async () => {
    for (let i = 1; i <= 5; i++) {
      expect(
        (await post({ currentTopic: '创业', reasonMode: 'llm' }, 'tok', 'user-rl-split')).status
      ).toBe(200)
    }
    // llm 桶已满，template 桶仍可用
    expect((await post({ currentTopic: '创业' }, 'tok', 'user-rl-split')).status).toBe(200)
  })
})
