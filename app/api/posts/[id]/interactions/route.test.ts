// ============================================================
// WF2：广场互动埋点 —— interactions route 接通创作者事件流
//
// 行为映射（撤回对称负向）：
//   POST   added   → post_like / post_save / post_style_resonate（contribute）
//   POST   removed → post_unlike / post_unsave（withdraw）
//   DELETE           → post_unlike / post_unsave（withdraw）
//
// 红线（与 WF1 同口径）：
//   1. trackEvent 永不阻塞主响应（fire-and-forget，void 调用）
//   2. 事件失败绝不影响互动本身的成功/失败
//   3. targetId=帖子 ID，projectId=null（广场内容与创作项目无关）
// ============================================================

import { describe, expect, it, vi, beforeEach } from 'vitest'

const trackEventMock = vi.fn().mockResolvedValue({ ok: true, idempotencyKey: 'k' })
vi.mock('@/lib/creative/interest/eventTracker', () => ({
  trackEvent: (...args: unknown[]) => trackEventMock(...args),
}))

// storage 模块顶层创建真实 Supabase 客户端（需要 env），整体 mock 掉
vi.mock('@/lib/storage', () => ({
  authenticateWithToken: vi.fn(),
  extractBearerToken: vi.fn(() => 't'),
}))
const authMock = vi.mocked(await import('@/lib/storage').then((m) => m.authenticateWithToken))

// ── route 依赖桩（storage 鉴权 + supabase 链式调用） ──

function makeAuthStub() {
  // per-table node：同一 node 复用时 maybeSingle 的返回会互相污染
  const makeNode = () => {
    const n: Record<string, unknown> = {}
    // 全链式：所有 builder 方法返回 node 自身，终结方法（insert/maybeSingle/delete 末尾 await）按需落值
    n.select = vi.fn(() => n)
    n.eq = vi.fn(() => n)
    n.delete = vi.fn(() => n)
    n.insert = vi.fn().mockResolvedValue({ error: null })
    // 默认 existing=null（走 added 分支）；post_interactions 查 id、posts 查计数——
    // 两处 maybeSingle 语义不同，由用例按需覆写
    n.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    return n
  }
  const tables: Record<string, Record<string, unknown>> = {}
  const rpc = vi.fn().mockResolvedValue({ error: null })
  const supabase = {
    from: vi.fn((table: string) => {
      tables[table] ??= makeNode()
      return tables[table]
    }),
    rpc,
  } as unknown as never
  return { supabase, tables }
}

const USER = '11111111-1111-1111-1111-111111111111'

beforeEach(() => {
  trackEventMock.mockClear()
  vi.resetModules() // route 模块内 reportInteractionEvent 闭包引用顶层导入，用例间重置保证隔离
})

describe('WF2：interactions route 事件埋点', () => {
  // 每用例动态 import route，并注入鉴权 mock
  async function callRoute(method: 'POST' | 'DELETE', interaction: string) {
    const { supabase } = makeAuthStub()
    authMock.mockResolvedValue({ supabase, userId: USER } as never)
    const mod = await import('./route')
    const req = new Request(
      `http://localhost/api/posts/p-1/interactions${method === 'DELETE' ? `?type=${interaction}` : ''}`,
      {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        ...(method === 'POST' ? { body: JSON.stringify({ interactionType: interaction }) } : {}),
      }
    )
    const res = await mod[method](req, { params: Promise.resolve({ id: 'p-1' }) })
    return { res, supabase }
  }

  it('POST like 添加 → post_like 事件（targetId=帖子ID, targetType=post）', async () => {
    const { res } = await callRoute('POST', 'like')
    expect(res.status).toBe(200)
    expect(trackEventMock).toHaveBeenCalledTimes(1)
    const [, userId, input] = trackEventMock.mock.calls[0]
    expect(userId).toBe(USER)
    expect(input).toMatchObject({
      type: 'post_like',
      targetType: 'post',
      targetId: 'p-1',
      projectId: null,
    })
  })

  it('POST save 添加 → post_save；POST style_resonate 添加 → post_style_resonate', async () => {
    await callRoute('POST', 'save')
    expect(trackEventMock.mock.calls[0][2]).toMatchObject({ type: 'post_save', targetId: 'p-1' })
    await callRoute('POST', 'style_resonate')
    expect(trackEventMock.mock.calls[1][2]).toMatchObject({
      type: 'post_style_resonate',
      targetId: 'p-1',
    })
  })

  it('POST like 取消（existing 命中 removed 分支）→ post_unlike（withdraw 对称）', async () => {
    // existing 命中需要 maybeSingle 返回记录：单独构造 supabase 桩
    const n: Record<string, unknown> = {}
    n.select = vi.fn(() => n)
    n.eq = vi.fn(() => n)
    n.delete = vi.fn(() => n)
    n.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'row-1' }, error: null })
    const rpc = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: vi.fn(() => n), rpc } as unknown as never
    authMock.mockResolvedValue({ supabase, userId: USER } as never)
    const mod = await import('./route')
    const req = new Request('http://localhost/api/posts/p-1/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ interactionType: 'like' }),
    })
    const res = await mod.POST(req, { params: Promise.resolve({ id: 'p-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.action).toBe('removed')
    expect(trackEventMock.mock.calls[0][2]).toMatchObject({ type: 'post_unlike', targetId: 'p-1' })
  })

  it('DELETE save → post_unsave', async () => {
    const { res } = await callRoute('DELETE', 'save')
    expect(res.status).toBe(200)
    expect(trackEventMock.mock.calls[0][2]).toMatchObject({ type: 'post_unsave', targetId: 'p-1' })
  })

  it('trackEvent 异步执行不阻塞响应（fire-and-forget：响应不等待其完成）', async () => {
    trackEventMock.mockImplementation(() => new Promise(() => {})) // 永不 resolve
    const { res } = await callRoute('POST', 'like')
    expect(res.status).toBe(200) // 响应照常返回
  })
})
