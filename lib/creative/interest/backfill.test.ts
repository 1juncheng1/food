import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runBackfill } from './backfill'
import { trackEvent } from './eventTracker'

vi.mock('./eventTracker', () => ({
  trackEvent: vi.fn(async () => ({ ok: true, idempotencyKey: 'k' })),
}))

const mockedTrack = vi.mocked(trackEvent)

/**
 * 链式 stub：backfill 用到的查询方法一律返回 chain，
 * 最后 await chain 时按表名吐结果。
 */
function makeClient(
  tables: Record<string, unknown[] | null>,
  errors: Record<string, { message: string }> = {}
) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit', 'maybeSingle']) {
    chain[m] = () => chain
  }
  let table = ''
  chain.then = (resolve: (v: unknown) => void) =>
    resolve({ data: tables[table] ?? null, error: errors[table] ?? null })
  return {
    from: (name: string) => {
      table = name
      return chain
    },
  } as unknown as SupabaseClient
}

/** 一条已发布到广场的帖子 */
function post(over: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    title: '我的作品',
    excerpt: '节选',
    category: 'AI 创业',
    tags: ['定价'],
    post_type: 'archive',
    style_vector: [0.1, 0.2],
    source_project_id: 'proj-1',
    created_at: '2026-09-01T00:00:00Z',
    ...over,
  }
}

describe('runBackfill · 发布事件回填', () => {
  beforeEach(() => mockedTrack.mockClear())

  it('孤儿发布（项目已删、项目表查不到）仍然回填 —— 最容易丢的一批证据', async () => {
    // creative_projects 返回空 = 该发布指向的项目此刻已不存在
    const stats = await runBackfill(
      makeClient({ creative_projects: [], posts: [post()] }),
      'u1'
    )

    expect(stats.publish).toBe(1)
    const call = mockedTrack.mock.calls.find((c) => c[2].type === 'work_publish')
    expect(call, '孤儿发布不应被 join 掉').toBeTruthy()
    expect(call![2]).toMatchObject({
      type: 'work_publish',
      targetType: 'post',
      targetId: 'post-1',
      projectId: 'proj-1', // 孤儿引用也要如实记录
      category: 'AI 创业',
      occurredAt: '2026-09-01T00:00:00Z',
    })
    expect(call![2].payload).toMatchObject({ backfill: true, post_type: 'archive' })
    expect(call![2].embedding).toEqual([0.1, 0.2]) // 复用存量向量，不重算
  })

  it('没有发布记录时不发 work_publish（不误报）', async () => {
    const stats = await runBackfill(
      makeClient({ creative_projects: [], posts: [] }),
      'u1'
    )
    expect(stats.publish).toBe(0)
    expect(mockedTrack.mock.calls.some((c) => c[2].type === 'work_publish')).toBe(false)
  })

  it('posts 查询失败时计入 errors 且不抛异常', async () => {
    const stats = await runBackfill(
      makeClient({ creative_projects: [] }, { posts: { message: 'boom' } }),
      'u1'
    )
    expect(stats.errors).toBeGreaterThan(0)
    expect(stats.publish).toBe(0)
  })
})
