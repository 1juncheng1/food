// ============================================================
// WF0：interestRepo IO 薄封装回归测试
//
// 实测根因 D5：findRunningBuild 曾按不存在的 created_at 列排序
// （interest_builds 只有 started_at），PostgREST 报错被静默吞掉，
// "在途折叠"永远返回 null → 一次页面访问可并发插入 6 个 build。
// ============================================================

import { describe, expect, it, vi } from 'vitest'
import { createBuild, findRunningBuild, saveEventEmbeddings, fetchEvents, reapStaleRunningBuild } from './interestRepo'
import type { SupabaseClient } from '@supabase/supabase-js'

/** 组装可观测的 PostgREST 链式 mock，记录每个调用 */
function mockChain(result: unknown, error: unknown = null) {
  const calls: {
    from: unknown[]
    select: unknown[]
    eq: unknown[][]
    order: unknown[][]
    limit: unknown[]
    gte: unknown[][]
  } = {
    from: [],
    select: [],
    eq: [],
    order: [],
    limit: [],
    gte: [],
  }
  const terminal = vi.fn().mockResolvedValue({ data: result, error })
  const node: Record<string, unknown> = {
    from: vi.fn((table: string) => {
      calls.from.push(table)
      return node
    }),
    select: vi.fn((cols: string) => {
      calls.select.push(cols)
      return node
    }),
    eq: vi.fn((col: string, val: unknown) => {
      calls.eq.push([col, val])
      return node
    }),
    order: vi.fn((col: string, opts?: unknown) => {
      calls.order.push([col, opts])
      return node
    }),
    limit: vi.fn((n: number) => {
      calls.limit.push(n)
      return node
    }),
    gte: vi.fn((col: string, val: unknown) => {
      calls.gte.push([col, val])
      return node
    }),
    maybeSingle: terminal,
  }
  return { client: node as unknown as SupabaseClient, calls, terminal }
}

describe('findRunningBuild', () => {
  it('按 started_at（而非不存在的 created_at）排序查在途 build', async () => {
    const { client, calls, terminal } = mockChain({ id: 'build-123' })
    const id = await findRunningBuild(client, 'user-1')

    expect(id).toBe('build-123')
    expect(calls.from).toContain('interest_builds')
    expect(calls.order.length).toBe(1)
    expect(calls.order[0]?.[0]).toBe('started_at')
    expect(terminal).toHaveBeenCalledOnce()
  })

  it('查询出错时返回 null（让调用方按"无在途"继续，但必须已记录错误，不吞异常）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = mockChain(null, { message: 'column created_at does not exist' })

    const id = await findRunningBuild(client, 'user-1')
    expect(id).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('只认新鲜 running：查询带 started_at 下界，僵尸 build（进程中断遗留）不折叠新 build', async () => {
    const { client, calls } = mockChain({ id: 'build-fresh' })
    await findRunningBuild(client, 'user-1')
    const gteCall = calls.gte.find(([col]) => col === 'started_at')
    expect(gteCall).toBeDefined()
    // 下界应在近 5 分钟窗口内（留出断言容差）
    const ageMs = Date.now() - Date.parse(gteCall![1] as string)
    expect(ageMs).toBeGreaterThan(4 * 60_000)
    expect(ageMs).toBeLessThan(6 * 60_000)
  })
})

// ── 僵尸 build 回收（fire-and-forget 进程退出/热重载遗留的永久 running 行） ──

/** 可编排 select/update 两段链的 mock */
function mockReap(row: { id: string; started_at: string } | null, updateError: { message: string } | null = null) {
  const updateFn = vi.fn()
  const terminal = vi.fn().mockResolvedValue({ data: row, error: null })
  const updateTerminal = vi.fn().mockResolvedValue({ data: null, error: updateError })
  const selectNode: Record<string, unknown> = {}
  selectNode.select = vi.fn().mockReturnValue(selectNode)
  selectNode.eq = vi.fn().mockReturnValue(selectNode)
  selectNode.order = vi.fn().mockReturnValue(selectNode)
  selectNode.limit = vi.fn().mockReturnValue(selectNode)
  selectNode.maybeSingle = terminal
  // update 链：eq 可链式，最终 await 整个链（PostgREST builder 是 thenable）
  const updateNode: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => resolve(updateTerminal()),
  }
  updateNode.eq = vi.fn().mockReturnValue(updateNode)
  const fromFn = vi.fn(() => new Proxy(selectNode, {
    get(_t, prop) {
      if (prop === 'update') return (...args: unknown[]) => {
        updateFn(...args)
        return updateNode
      }
      return selectNode[prop as string]
    },
  }))
  const client: Record<string, unknown> = { from: fromFn }
  return { client: client as unknown as SupabaseClient, terminal, updateTerminal, updateFn }
}

describe('reapStaleRunningBuild', () => {
  it('started_at 超过 5 分钟的 running 行 → 置 failed 并返回其 id', async () => {
    const stale = { id: 'zombie-1', started_at: new Date(Date.now() - 10 * 60_000).toISOString() }
    const { client, updateFn, updateTerminal } = mockReap(stale)
    const id = await reapStaleRunningBuild(client as unknown as SupabaseClient, 'user-1')
    expect(id).toBe('zombie-1')
    expect(updateFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(updateTerminal).toHaveBeenCalledOnce()
  })

  it('running 行仍在新鲜窗口内 → 不回收，返回 null', async () => {
    const fresh = { id: 'running-1', started_at: new Date(Date.now() - 30_000).toISOString() }
    const { client, updateFn } = mockReap(fresh)
    const id = await reapStaleRunningBuild(client as unknown as SupabaseClient, 'user-1')
    expect(id).toBeNull()
    expect(updateFn).not.toHaveBeenCalled()
  })

  it('无 running 行 → 返回 null', async () => {
    const { client, updateFn } = mockReap(null)
    const id = await reapStaleRunningBuild(client as unknown as SupabaseClient, 'user-1')
    expect(id).toBeNull()
    expect(updateFn).not.toHaveBeenCalled()
  })

  it('update 失败 → 不抛异常，返回 null（下次 build 重试回收）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stale = { id: 'zombie-2', started_at: new Date(Date.now() - 10 * 60_000).toISOString() }
    const { client } = mockReap(stale, { message: '42501 permission denied' })
    const id = await reapStaleRunningBuild(client as unknown as SupabaseClient, 'user-1')
    expect(id).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('createBuild（WF0 running 互斥索引协作）', () => {
  /** createBuild 只走 from→insert 两段链 */
  function mockInsert(error: { code?: string; message: string } | null) {
    const insertFn = vi.fn().mockResolvedValue({ data: null, error })
    const fromFn = vi.fn().mockReturnValue({ insert: insertFn })
    const client = { from: fromFn } as unknown as SupabaseClient
    return { client, insertFn, fromFn }
  }

  it('撞 running 唯一部分索引（23505）时静默跳过：返回 null、记 info 不记 error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { client } = mockInsert({ code: '23505', message: 'duplicate key value violates unique constraint' })

    const id = await createBuild(client, 'user-1', 'incremental')
    expect(id).toBeNull()
    expect(errSpy).not.toHaveBeenCalled()
    expect(infoSpy).toHaveBeenCalled()
    errSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it('其他插入失败仍按错误记录（不能借互斥逻辑把真实故障一起吞掉）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = mockInsert({ code: '42501', message: 'permission denied for table interest_builds' })

    const id = await createBuild(client, 'user-1', 'full')
    expect(id).toBeNull()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('saveEventEmbeddings（WF9 修复：补算结果回写，杜绝每次 build 重复烧 50 次 embedding API）', () => {
  it('逐条 update creator_events.embedding；失败记 error 不抛出', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fromFn = vi.fn().mockImplementation(() => ({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    }))
    const client = { from: fromFn } as unknown as SupabaseClient

    const vector = Array.from({ length: 1024 }, () => 0.1)
    await saveEventEmbeddings(client, [
      { id: 'e-1', embedding: vector },
      { id: 'e-2', embedding: vector },
    ])
    expect(fromFn).toHaveBeenCalledWith('creator_events')
    expect(fromFn).toHaveBeenCalledTimes(2)
    errSpy.mockRestore()
  })

  it('空列表直接返回（不触库）', async () => {
    const fromFn = vi.fn()
    const client = { from: fromFn } as unknown as SupabaseClient
    await saveEventEmbeddings(client, [])
    expect(fromFn).not.toHaveBeenCalled()
  })
})

describe('fetchEvents（WF9 修复：pgvector 字符串形态解析，否则回写的向量永远读不回来）', () => {
  /** select→order→limit 链式 mock，返回给定 data */
  function mockSelect(data: unknown) {
    const node: Record<string, unknown> = {}
    node.select = vi.fn().mockReturnValue(node)
    node.eq = vi.fn().mockReturnValue(node)
    node.order = vi.fn().mockReturnValue(node)
    node.limit = vi.fn().mockResolvedValue({ data, error: null })
    const client = { from: vi.fn().mockReturnValue(node) } as unknown as SupabaseClient
    return client
  }

  it('PostgREST 返回的 vector 字符串 "[0.1,0.2,...]" 被解析为 number[]', async () => {
    const vectorLiteral = `[${Array.from({ length: 1024 }, (_, i) => (i % 2 ? 0.5 : -0.5)).join(',')}]`
    const client = mockSelect([
      {
        id: 'e-1',
        event_type: 'work_generate',
        target_type: 'generation',
        target_id: 't1',
        project_id: null,
        occurred_at: '2026-09-19T00:00:00Z',
        embedding: vectorLiteral,
        interpretation: null,
        interpret_status: 'none',
        payload: { topic_excerpt: 'WF9TEST 主题' },
      },
    ])
    const events = await fetchEvents(client, 'u-1')
    expect(events).toHaveLength(1)
    expect(Array.isArray(events[0].embedding)).toBe(true)
    expect(events[0].embedding).toHaveLength(1024)
    expect((events[0].embedding as number[])[0]).toBeCloseTo(-0.5)
  })

  it('无向量/畸形向量 → null（不抛错）', async () => {
    const client = mockSelect([
      { id: 'a', event_type: 'work_generate', target_type: 'generation', occurred_at: '2026-09-19T00:00:00Z', embedding: null, payload: {} },
      { id: 'b', event_type: 'work_generate', target_type: 'generation', occurred_at: '2026-09-19T00:00:00Z', embedding: '[broken', payload: {} },
      { id: 'c', event_type: 'work_generate', target_type: 'generation', occurred_at: '2026-09-19T00:00:00Z', embedding: [0.1, 0.2], payload: {} },
    ])
    const events = await fetchEvents(client, 'u-1')
    expect(events[0].embedding).toBeNull()
    expect(events[1].embedding).toBeNull()
    expect(events[2].embedding).toBeNull() // 非全数值/维度不符 → null
  })
})
