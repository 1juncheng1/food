import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isMissingMigrationError, loadLinkedWorks } from './knowledgeLink'

// loadLinkedWorks 是列表页一次拿 N 条单元关联的唯一入口：
// 这里用假 client 覆盖它最容易被写错的三个地方 —— 分组、孤儿行、迁移未执行。

const K1 = '11111111-1111-1111-1111-111111111111'
const K2 = '22222222-2222-2222-2222-222222222222'
const P1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const P2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

interface TableResult {
  data: unknown[] | null
  error?: { code?: string; message?: string } | null
}

function fakeClient(tables: Record<string, TableResult>): SupabaseClient {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    const run = async () => tables[table] ?? { data: [], error: null }
    b.select = () => b
    b.eq = () => b
    b.in = () => b
    b.then = (resolve: (v: unknown) => unknown) => run().then(resolve)
    return b
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient
}

describe('isMissingMigrationError', () => {
  it('表不存在 / 函数不存在都判定为迁移未执行', () => {
    expect(isMissingMigrationError({ code: '42P01' })).toBe(true)
    expect(isMissingMigrationError({ code: '42883' })).toBe(true)
    expect(isMissingMigrationError({ code: 'PGRST202' })).toBe(true)
  })

  it('普通错误不算迁移问题 —— 不能把线上故障伪装成"没跑迁移"', () => {
    expect(isMissingMigrationError({ code: '42501' })).toBe(false)
    expect(isMissingMigrationError({ message: 'boom' })).toBe(false)
    expect(isMissingMigrationError(null)).toBe(false)
  })
})

describe('loadLinkedWorks', () => {
  const USER = 'u-1'

  it('按知识单元分组，并补上作品标题', async () => {
    const supabase = fakeClient({
      creator_knowledge_links: {
        data: [
          { knowledge_id: K1, project_id: P1, origin: 'manual', created_at: '2026-01-02T00:00:00Z' },
          { knowledge_id: K1, project_id: P2, origin: 'auto_history', created_at: '2026-01-01T00:00:00Z' },
          { knowledge_id: K2, project_id: P1, origin: 'manual', created_at: '2026-01-03T00:00:00Z' },
        ],
      },
      creative_projects: {
        data: [
          { id: P1, title: '选题拆解', topic: '选题', status: 'active', updated_at: '2026-02-01T00:00:00Z' },
          { id: P2, title: '商业分析', topic: '商业', status: 'finalized', updated_at: '2026-03-01T00:00:00Z' },
        ],
      },
    })

    const result = await loadLinkedWorks(supabase, USER, [K1, K2])
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(Object.keys(result.links).sort()).toEqual([K1, K2].sort())
    // 同一知识内按作品更新时间倒序：最新还在用的排前面
    expect(result.links[K1].map((w) => w.projectId)).toEqual([P2, P1])
    expect(result.links[K1][0]).toMatchObject({
      title: '商业分析',
      status: 'finalized',
      origin: 'auto_history',
    })
    expect(result.links[K2]).toHaveLength(1)
  })

  it('作品已被删掉（孤儿行）时不报错也不展示 —— 并发删除窗口必然出现', async () => {
    const supabase = fakeClient({
      creator_knowledge_links: {
        data: [{ knowledge_id: K1, project_id: P1, origin: 'manual', created_at: '2026-01-02T00:00:00Z' }],
      },
      creative_projects: { data: [] },
    })

    const result = await loadLinkedWorks(supabase, USER, [K1])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.links[K1]).toBeUndefined()
  })

  it('关联表不存在：返回 missing-migration，而不是把整页变成错误态', async () => {
    const supabase = fakeClient({
      creator_knowledge_links: { data: null, error: { code: '42P01', message: 'relation missing' } },
    })
    const result = await loadLinkedWorks(supabase, USER, [K1])
    expect(result).toEqual({ ok: false, reason: 'missing-migration' })
  })

  it('作品表查询失败是真失败：要能被上层记日志，不能被当成未迁移', async () => {
    const supabase = fakeClient({
      creator_knowledge_links: {
        data: [
          { knowledge_id: K1, project_id: P1, origin: 'manual', created_at: '2026-01-02T00:00:00Z' },
        ],
      },
      creative_projects: { data: null, error: { code: '42501', message: 'permission denied' } },
    })
    const result = await loadLinkedWorks(supabase, USER, [K1])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('error')
    expect(result.message).toBe('permission denied')
  })

  it('关联为空时不查作品表：列表页不该为没有关联的知识白发请求', async () => {
    const supabase = fakeClient({
      creator_knowledge_links: { data: [] },
      creative_projects: { data: null, error: { code: '42501', message: '不该被查询到' } },
    })
    expect(await loadLinkedWorks(supabase, USER, [K1])).toEqual({ ok: true, links: {} })
  })

  it('没有 ids 时直接返回空，不发多余请求', async () => {
    const supabase = fakeClient({})
    expect(await loadLinkedWorks(supabase, USER, [])).toEqual({ ok: true, links: {} })
  })
})
