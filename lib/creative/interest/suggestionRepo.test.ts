// ============================================================
// WF1：suggestionRepo.getSuggestionById —— 推荐卡单卡读取
//
// events 端点（曝光/点击/✕）需要按 rec_id 读取卡片主题并校验归属
// （id + user_id 双条件），防止越权对他人推荐卡上报行为。
// ============================================================

import { describe, expect, it, vi } from 'vitest'
import { getSuggestionById, insertSuggestions, getActiveSuggestions } from './suggestionRepo'
import type { SuggestionInsertInput } from './suggestionRepo'
import type { SupabaseClient } from '@supabase/supabase-js'

/** 组装可观测的 PostgREST 链式 mock（from→select→eq→eq→maybeSingle） */
function mockChain(result: unknown, error: unknown = null) {
  const calls: { from: unknown[]; select: unknown[]; eq: unknown[][] } = {
    from: [],
    select: [],
    eq: [],
  }
  const terminal = vi.fn().mockResolvedValue({ data: result, error })
  const node: Record<string, unknown> = {
    select: vi.fn((cols: string) => {
      calls.select.push(cols)
      return node
    }),
    eq: vi.fn((col: string, val: string) => {
      calls.eq.push([col, val])
      return node
    }),
    maybeSingle: terminal,
  }
  const client = {
    from: vi.fn((table: string) => {
      calls.from.push(table)
      return node
    }),
  } as unknown as SupabaseClient
  return { client, calls, terminal }
}

describe('getSuggestionById（WF1 反馈闭环前置）', () => {
  it('按 id + user_id 双条件查询单卡，返回 topic/title/cluster_code/slot', async () => {
    const row = { id: 'rec1', topic: 'AI创业', title: 'T', cluster_code: 'c1', slot: 'core_gap' }
    const { client, calls } = mockChain(row)

    const got = await getSuggestionById(client, 'rec1', 'user-1')
    expect(got).toEqual(row)
    expect(calls.from).toEqual(['interest_suggestions'])
    expect(calls.select[0]).toContain('topic')
    expect(calls.eq).toEqual([
      ['id', 'rec1'],
      ['user_id', 'user-1'],
    ])
  })

  it('查不到（不存在或非本人）返回 null', async () => {
    const { client } = mockChain(null)
    expect(await getSuggestionById(client, 'rec-x', 'user-1')).toBeNull()
  })

  it('查询出错返回 null 且记录错误（不吞异常不抛出）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = mockChain(null, { message: 'boom' })
    expect(await getSuggestionById(client, 'rec1', 'user-1')).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

// ============================================================
// WF6：AI 理由五字段落库（core_question/why_recommend/creation_angle/
//      related_knowledge/reason_source，列已在 WF0 §16.10 预置）
// ============================================================

function insertInput(over: Partial<SuggestionInsertInput> = {}): SuggestionInsertInput {
  return {
    clusterCode: 'c_ai',
    slot: 'core_gap',
    source: 'own_inspiration',
    title: 'AI 正在改变普通人的工作方式',
    description: 'D',
    topic: 'AI创业',
    formHint: '其他',
    score: 0.77,
    scoreBreakdown: { interestMatch: 0.65, recentBehavior: 0.95, trend: 1, quality: 0.8, explore: 0.4 },
    evidence: { facts: [] },
    ...over,
  }
}

/** 捕获 insert 载荷的可观测 mock */
function mockInsertCapture() {
  const captured: Record<string, unknown>[] = []
  const node: Record<string, unknown> = {
    insert: vi.fn((rows: Record<string, unknown>[]) => {
      captured.push(...rows)
      return node
    }),
    select: vi.fn(() => node),
    eq: vi.fn(() => node),
    order: vi.fn(() => node),
    limit: vi.fn(() => node),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  }
  const client = { from: vi.fn(() => node) } as unknown as SupabaseClient
  return { client, captured }
}

describe('insertSuggestions：AI 理由字段映射（WF6）', () => {
  it('五字段 snake_case 落库；reason_source 默认 template、related_knowledge 默认 []', async () => {
    const { client, captured } = mockInsertCapture()
    const n = await insertSuggestions(client, 'user-1', 'build-1', [
      insertInput({
        coreQuestion: '普通人该如何借力 AI？',
        whyRecommend: '你最近 4 篇作品都在讨论「AI创业」',
        creationAngle: '从职业选择切入',
        relatedKnowledge: ['你的AI创业案例素材'],
        reasonSource: 'ai',
      }),
      insertInput(), // 无 AI 理由的卡（AI 失败/模板）
    ])
    expect(n).toBe(2)
    const withAi = captured[0]
    expect(withAi.core_question).toBe('普通人该如何借力 AI？')
    expect(withAi.why_recommend).toBe('你最近 4 篇作品都在讨论「AI创业」')
    expect(withAi.creation_angle).toBe('从职业选择切入')
    expect(withAi.related_knowledge).toEqual(['你的AI创业案例素材'])
    expect(withAi.reason_source).toBe('ai')
    const template = captured[1]
    expect(template.core_question).toBeNull()
    expect(template.reason_source).toBe('template')
    expect(template.related_knowledge).toEqual([])
  })

  it('getActiveSuggestions select 携带五个新列（API 透出前置）', async () => {
    const { client } = mockInsertCapture()
    await getActiveSuggestions(client, 'user-1', 6)
    const node = (client.from as ReturnType<typeof vi.fn>).mock.results[0].value as Record<string, unknown>
    const cols = (node.select as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    for (const col of ['core_question', 'why_recommend', 'creation_angle', 'related_knowledge', 'reason_source']) {
      expect(cols).toContain(col)
    }
  })
})
