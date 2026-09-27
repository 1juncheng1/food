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
  const selects: Record<string, string[]> = {}
  const chain: Record<string, unknown> = {}
  for (const m of ['eq', 'in', 'not', 'order', 'limit', 'maybeSingle']) {
    chain[m] = () => chain
  }
  let table = ''
  // 记录 select 的列：写错列名会让整段查询 42703 失败，而失败只累加 errors、
  // 不抛异常 —— 这是本模块最容易静默丢数据的一类 bug，必须可断言
  chain.select = (cols: string) => {
    ;(selects[table] ??= []).push(cols)
    return chain
  }
  chain.then = (resolve: (v: unknown) => void) =>
    resolve({ data: tables[table] ?? null, error: errors[table] ?? null })
  return {
    client: {
      from: (name: string) => {
        table = name
        return chain
      },
    } as unknown as SupabaseClient,
    selects,
  }
}

/** 一条已发布到广场的帖子（真实列：content，posts 没有 title / excerpt） */
function post(over: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    content: '# 我的作品\n\n正文开头……',
    category: 'AI 创业',
    tags: ['定价'],
    post_type: 'archive',
    style_vector: [0.1, 0.2],
    source_project_id: 'proj-1',
    created_at: '2026-09-01T00:00:00Z',
    ...over,
  }
}

/**
 * posts 表的真实列（见 supabase/setup.sql）。
 * 曾因写了 title / excerpt 两个不存在的列，导致发布回填对全部用户静默为 0。
 */
const POSTS_COLUMNS = new Set([
  'id',
  'user_id',
  'content',
  'content_type',
  'category',
  'tags',
  'style_vector',
  'like_count',
  'comment_count',
  'save_count',
  'is_public',
  'created_at',
  'image_url',
  'post_type',
  'archive',
  'source_project_id',
])

describe('runBackfill · 发布事件回填', () => {
  beforeEach(() => mockedTrack.mockClear())

  it('孤儿发布（项目已删、项目表查不到）仍然回填 —— 最容易丢的一批证据', async () => {
    // creative_projects 返回空 = 该发布指向的项目此刻已不存在
    const stats = await runBackfill(
      makeClient({ creative_projects: [], posts: [post()] }).client,
      'u1'
    )

    expect(stats.publish).toBe(1)
    const call = mockedTrack.mock.calls.find((c) => c[2].type === 'work_publish')
    expect(call, '孤儿发布不应被 join 掉').toBeTruthy()
    expect(call![2]).toMatchObject({
      type: 'work_publish',
      targetType: 'post',
      targetId: 'post-1',
      // 外键不允许引用已删项目：事件照发，但 project_id 置空
      projectId: null,
      category: 'AI 创业',
      occurredAt: '2026-09-01T00:00:00Z',
    })
    expect(call![2].payload).toMatchObject({
      backfill: true,
      post_type: 'archive',
      orphan_project: true,
      source_project_id: 'proj-1', // 原始引用留在 payload，证据不丢
    })
    expect(call![2].embedding).toEqual([0.1, 0.2]) // 复用存量向量，不重算
  })

  it('项目仍在时正常带上 project_id（外键约束下的正常路径）', async () => {
    const stats = await runBackfill(
      makeClient({
        creative_projects: [{ id: 'proj-1', title: 'x', topic: 't', status: 'draft' }],
        posts: [post()],
      }).client,
      'u1'
    )
    expect(stats.publish).toBe(1)
    const call = mockedTrack.mock.calls.find((c) => c[2].type === 'work_publish')!
    expect(call[2].projectId).toBe('proj-1')
    expect(call[2].payload).toMatchObject({ orphan_project: false })
  })

  it('标题从 content 首行还原（posts 没有 title 列）', async () => {
    await runBackfill(makeClient({ creative_projects: [], posts: [post()] }).client, 'u1')
    const call = mockedTrack.mock.calls.find((c) => c[2].type === 'work_publish')!
    expect(call[2].topicExcerpt).toBe('我的作品')
  })

  it('首行不是标题时退回正文开头，不产空字符串', async () => {
    await runBackfill(
      makeClient({ creative_projects: [], posts: [post({ content: '一段纯灵感正文' })] }).client,
      'u1'
    )
    const call = mockedTrack.mock.calls.find((c) => c[2].type === 'work_publish')!
    expect(call[2].topicExcerpt).toBe('一段纯灵感正文')
  })

  it('没有发布记录时不发 work_publish（不误报）', async () => {
    const stats = await runBackfill(
      makeClient({ creative_projects: [], posts: [] }).client,
      'u1'
    )
    expect(stats.publish).toBe(0)
    expect(mockedTrack.mock.calls.some((c) => c[2].type === 'work_publish')).toBe(false)
  })

  it('posts 查询只选真实存在的列（写错列名会让整段静默失败）', async () => {
    const { client, selects } = makeClient({ creative_projects: [], posts: [post()] })
    await runBackfill(client, 'u1')
    const used = (selects.posts ?? []).flatMap((s) => s.split(',').map((c) => c.trim()))
    expect(used.length).toBeGreaterThan(0)
    for (const col of used) {
      expect(POSTS_COLUMNS.has(col), `posts 不存在列「${col}」`).toBe(true)
    }
  })

  it('posts 查询失败时计入 errors 且不抛异常', async () => {
    const stats = await runBackfill(
      makeClient({ creative_projects: [] }, { posts: { message: 'boom' } }).client,
      'u1'
    )
    expect(stats.errors).toBeGreaterThan(0)
    expect(stats.publish).toBe(0)
  })
})
