// ============================================================
// WF1：POST /api/inspirations/events —— 推荐反馈事件端点
//
// 曝光（recommend_impression，权重 0，只做 CTR 分母）、
// 点击（recommend_click，0.15）、✕ 不感兴趣（recommend_dismiss，-1.5，
// 卡片离队 + 触发增量重建）三类行为的服务端入口。
//
// 契约：
//   - 必须登录（游客无推荐卡，无反馈可言）→ 401
//   - type ∈ {impression, click, dismiss}，rec_id 非空字符串 → 否则 400
//   - dismiss 校验卡片归属（id+user_id 双条件）→ 不存在/非本人 404
//   - dismiss 时用卡片 topic 补算 embedding，让负反馈精确落进对应兴趣簇
//   - 每用户限流（EVENT_RATE_LIMIT_PER_MIN）→ 超限 429
//   - trackEvent 永不抛错；本端点任何下游失败都不影响 200 响应
// ============================================================

import { describe, expect, it, vi, beforeEach } from 'vitest'

const { getUser, trackEvent, markDismissed, getSuggestionById, runBuild, generateEmbedding, rateLimit } =
  vi.hoisted(() => ({
    getUser: vi.fn(),
    trackEvent: vi.fn().mockResolvedValue({ ok: true, idempotencyKey: 'k' }),
    markDismissed: vi.fn().mockResolvedValue(undefined),
    getSuggestionById: vi.fn().mockResolvedValue(null),
    runBuild: vi.fn().mockResolvedValue(null),
    generateEmbedding: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
    rateLimit: vi.fn().mockReturnValue({ ok: true, retryAfterSec: 0 }),
  }))

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => ({ auth: { getUser } }),
}))
vi.mock('@/lib/creative/interest/eventTracker', () => ({ trackEvent }))
vi.mock('@/lib/creative/interest/suggestionRepo', () => ({ getSuggestionById, markDismissed }))
vi.mock('@/lib/creative/interest/builder', () => ({ runBuild }))
vi.mock('@/lib/storage', () => ({ generateEmbedding }))
vi.mock('@/lib/rateLimit', () => ({ rateLimit }))
vi.mock('@/lib/creative/interest/config', () => ({ EVENT_RATE_LIMIT_PER_MIN: 60 }))

import { POST } from './route'

const REC_ROW = { id: 'rec1', topic: 'AI创业', title: 'AI 正在改变普通人的工作方式', cluster_code: 'c_ai', slot: 'core_gap' }

function post(body: unknown, withToken = true) {
  return POST(
    new Request('http://localhost/api/inspirations/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(withToken ? { authorization: 'Bearer tok' } : {}),
      },
      body: JSON.stringify(body),
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 })
  getSuggestionById.mockResolvedValue(null)
})

describe('POST /api/inspirations/events', () => {
  it('无 token → 401，不触碰任何下游', async () => {
    const res = await post({ type: 'click', rec_id: 'rec1' }, false)
    expect(res.status).toBe(401)
    expect(trackEvent).not.toHaveBeenCalled()
  })

  it('getUser 失败（token 失效）→ 401', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'jwt expired' } })
    const res = await post({ type: 'click', rec_id: 'rec1' })
    expect(res.status).toBe(401)
    expect(trackEvent).not.toHaveBeenCalled()
  })

  it('非法 type → 400；缺 rec_id → 400', async () => {
    expect((await post({ type: 'like', rec_id: 'rec1' })).status).toBe(400)
    expect((await post({ type: 'click' })).status).toBe(400)
    expect(trackEvent).not.toHaveBeenCalled()
  })

  it('限流超限 → 429，不触下游', async () => {
    rateLimit.mockReturnValue({ ok: false, retryAfterSec: 30 })
    const res = await post({ type: 'impression', rec_id: 'rec1' })
    expect(res.status).toBe(429)
    expect(trackEvent).not.toHaveBeenCalled()
  })

  it('impression：recommend_impression 事件 + dailyKey 幂等，不改队列不触发重建', async () => {
    const res = await post({ type: 'impression', rec_id: 'rec1' })
    expect(res.status).toBe(200)
    const input = trackEvent.mock.calls[0][2]
    expect(input.type).toBe('recommend_impression')
    expect(input.targetType).toBe('inspiration')
    expect(input.targetId).toBe('rec1')
    expect(input.dailyKey).toBe(true)
    expect(markDismissed).not.toHaveBeenCalled()
    expect(runBuild).not.toHaveBeenCalled()
  })

  it('click：recommend_click 事件 + dailyKey 幂等，不触发重建', async () => {
    const res = await post({ type: 'click', rec_id: 'rec1' })
    expect(res.status).toBe(200)
    expect(trackEvent.mock.calls[0][2].type).toBe('recommend_click')
    expect(markDismissed).not.toHaveBeenCalled()
    expect(runBuild).not.toHaveBeenCalled()
  })

  it('dismiss 正常路径：校验归属 → 卡片离队 → 带卡片主题向量的事件 → 触发增量重建', async () => {
    getSuggestionById.mockResolvedValue(REC_ROW)

    const res = await post({ type: 'dismiss', rec_id: 'rec1' })
    expect(res.status).toBe(200)
    expect(getSuggestionById).toHaveBeenCalledWith(expect.anything(), 'rec1', 'user-1')
    expect(markDismissed).toHaveBeenCalledWith(expect.anything(), 'rec1')

    const input = trackEvent.mock.calls[0][2]
    expect(input.type).toBe('recommend_dismiss')
    expect(input.targetId).toBe('rec1')
    expect(input.topicExcerpt).toBe('AI创业')
    expect(Array.isArray(input.embedding)).toBe(true)
    expect(input.embedding).toHaveLength(1024)
    expect(runBuild).toHaveBeenCalledWith(expect.anything(), 'user-1', 'incremental')
  })

  it('dismiss 卡片不存在/非本人 → 404，不落事件不触发重建', async () => {
    const res = await post({ type: 'dismiss', rec_id: 'rec-other' })
    expect(res.status).toBe(404)
    expect(trackEvent).not.toHaveBeenCalled()
    expect(runBuild).not.toHaveBeenCalled()
  })

  it('dismiss 时 embedding 失败仍成功（embedding=null 照常落事件，不阻塞负反馈）', async () => {
    getSuggestionById.mockResolvedValue(REC_ROW)
    generateEmbedding.mockRejectedValueOnce(new Error('embedding service down'))

    const res = await post({ type: 'dismiss', rec_id: 'rec1' })
    expect(res.status).toBe(200)
    expect(trackEvent.mock.calls[0][2].embedding).toBeNull()
    expect(markDismissed).toHaveBeenCalled()
  })
})
