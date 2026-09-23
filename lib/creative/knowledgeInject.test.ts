import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  MAX_INJECT_UNITS,
  relevanceScore,
  selectUnitsForPrompt,
  formatKnowledgeForPrompt,
  fetchInjectableUnits,
  summarizeInjectedUnits,
  normalizeInjectedUnits,
} from './knowledgeInject'
import type { CreatorKnowledgeUnit } from './knowledgeUnit'

function unit(over: Partial<CreatorKnowledgeUnit> = {}): CreatorKnowledgeUnit {
  return {
    id: 'u1',
    userId: 'user-1',
    concept: '默认概念',
    claim: '默认命题',
    kind: '观点',
    domainScope: [],
    confidence: 0.8,
    status: '已确认',
    sourceItemIds: ['a', 'b'],
    sourceCount: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

/** DB 行形状（snake_case），供 fetchInjectableUnits 走 normalizeKnowledgeUnit */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    user_id: 'user-1',
    concept: 'AI 与教育',
    claim: 'AI 不会取代老师，而是把老师从重复劳动中解放出来',
    kind: '观点',
    domain_scope: ['教育'],
    confidence: 0.8,
    status: '已确认',
    source_item_ids: ['id-1', 'id-2'],
    source_count: 2,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

/** 链式 supabase 假客户端：limit() 落到一个 Promise 上 */
function mockClient(res: { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {}
  builder.select = () => builder
  builder.eq = () => builder
  builder.order = () => builder
  builder.limit = () => Promise.resolve(res)
  return { from: () => builder } as unknown as SupabaseClient
}

describe('relevanceScore（确定性字面打分）', () => {
  it('无任何交集 → 0（不注入）', () => {
    const u = unit({ concept: '咖啡烘焙', domainScope: ['饮品'] })
    expect(relevanceScore(u, '今天聊聊短视频运营')).toBe(0)
  })

  it('concept 命中 → 记 concept 权重', () => {
    const u = unit({ concept: '咖啡烘焙', domainScope: [] })
    expect(relevanceScore(u, '聊聊咖啡烘焙的几个误区')).toBe(3)
  })

  it('domainScope 每个命中词各记一次', () => {
    const u = unit({ concept: '无关概念', domainScope: ['咖啡', '烘焙'] })
    expect(relevanceScore(u, '咖啡与烘焙')).toBe(4)
  })

  it('concept 与 domainScope 同词时只计一次（避免同一信号重复加权）', () => {
    const u = unit({ concept: '咖啡', domainScope: ['咖啡'] })
    expect(relevanceScore(u, '咖啡')).toBe(3)
  })

  it('长度 < 2 的词不参与匹配（中文单字必然误命中）', () => {
    const u = unit({ concept: '猫' , domainScope: ['哦'] })
    expect(relevanceScore(u, '猫和哦')).toBe(0)
  })

  it('topic 为空 → 0，避免空主题把全部知识灌进 prompt', () => {
    const u = unit({ concept: '咖啡' })
    expect(relevanceScore(u, '')).toBe(0)
    expect(relevanceScore(u, '   ')).toBe(0)
  })
})

describe('selectUnitsForPrompt（挑选与排序）', () => {
  it('无关单元一律不入选', () => {
    const units = [unit({ concept: '咖啡' }), unit({ id: 'u2', concept: '茶叶' })]
    expect(selectUnitsForPrompt(units, 'AI 教育')).toEqual([])
  })

  it('相关度相同时置信度高者优先', () => {
    const units = [
      unit({ id: 'low', concept: 'AI', confidence: 0.6 }),
      unit({ id: 'high', concept: 'AI', confidence: 0.95 }),
    ]
    expect(selectUnitsForPrompt(units, 'AI 教育').map((u) => u.id)).toEqual(['high', 'low'])
  })

  it('相关度高者优先，权重压过置信度', () => {
    const units = [
      unit({ id: 'domain', concept: '无关', domainScope: ['AI'], confidence: 1 }),
      unit({ id: 'concept', concept: 'AI', domainScope: [], confidence: 0.6 }),
    ]
    // domainScope 权重 2 < concept 权重 3
    expect(selectUnitsForPrompt(units, 'AI').map((u) => u.id)).toEqual(['concept', 'domain'])
  })

  it('分数与置信度都相同时按 id 排序，保证结果完全确定', () => {
    const units = [
      unit({ id: 'z', concept: 'AI', confidence: 0.8 }),
      unit({ id: 'a', concept: 'AI', confidence: 0.8 }),
    ]
    expect(selectUnitsForPrompt(units, 'AI').map((u) => u.id)).toEqual(['a', 'z'])
  })

  it('max 生效且 max=0 返回空', () => {
    const units = [
      unit({ id: '1', concept: '咖啡' }),
      unit({ id: '2', concept: '烘焙' }),
      unit({ id: '3', concept: '拉花' }),
    ]
    expect(selectUnitsForPrompt(units, '咖啡烘焙拉花', 2)).toHaveLength(2)
    expect(selectUnitsForPrompt(units, '咖啡烘焙拉花', 0)).toEqual([])
  })

  it('默认上限为 MAX_INJECT_UNITS', () => {
    const units = Array.from({ length: 12 }, (_, i) =>
      unit({ id: `u${i}`, concept: 'AI', confidence: 0.9 - i / 100 })
    )
    expect(selectUnitsForPrompt(units, 'AI')).toHaveLength(MAX_INJECT_UNITS)
  })
})

describe('formatKnowledgeForPrompt', () => {
  it('空列表 → 空串（可以直接拼进 prompt 而不污染内容）', () => {
    expect(formatKnowledgeForPrompt([])).toBe('')
  })

  it('带上 kind 与 claim 原文', () => {
    const out = formatKnowledgeForPrompt([unit({ kind: '数据', claim: '某条数据结论' })])
    expect(out).toContain('[数据] 某条数据结论')
  })

  it('明确禁止代创作者编造未列出的主张', () => {
    const out = formatKnowledgeForPrompt([unit()])
    expect(out).toContain('不得代为编造')
  })
})

describe('summarizeInjectedUnits（回传摘要）', () => {
  it('不含 sourceItemIds 等内部溯源信息', () => {
    const out = summarizeInjectedUnits([unit({ id: 'x', sourceItemIds: ['a', 'b'] })])
    expect(out).toEqual([
      { concept: '默认概念', claim: '默认命题', kind: '观点', confidence: 0.8 },
    ])
    expect(JSON.stringify(out)).not.toContain('sourceItemIds')
  })
})

describe('normalizeInjectedUnits（used_knowledge jsonb 回读）', () => {
  it('非数组一律空（null / 对象 / 字符串都不炸）', () => {
    expect(normalizeInjectedUnits(null)).toEqual([])
    expect(normalizeInjectedUnits(undefined)).toEqual([])
    expect(normalizeInjectedUnits('[]')).toEqual([])
    expect(normalizeInjectedUnits({ concept: 'x', claim: 'y' })).toEqual([])
  })

  it('完整条目原样还原', () => {
    expect(
      normalizeInjectedUnits([{ concept: '定价', claim: '年付优于月付', kind: '观点', confidence: 0.75 }])
    ).toEqual([{ concept: '定价', claim: '年付优于月付', kind: '观点', confidence: 0.75 }])
  })

  it('缺 concept 或 claim 的条目整条丢弃（用户看不出"参考了什么"）', () => {
    expect(normalizeInjectedUnits([{ concept: '定价' }])).toEqual([])
    expect(normalizeInjectedUnits([{ claim: '年付优于月付' }])).toEqual([])
    expect(normalizeInjectedUnits([{ concept: '   ', claim: '空白概念' }])).toEqual([])
  })

  it('缺 kind / confidence 时如实留 null，不用空串或 0 冒充', () => {
    const out = normalizeInjectedUnits([{ concept: '定价', claim: '年付优于月付' }])
    expect(out[0]?.kind).toBeNull()
    expect(out[0]?.confidence).toBeNull()
  })

  it('脏形状的成员被跳过而不污染整批', () => {
    const out = normalizeInjectedUnits([
      { concept: 'A', claim: 'a', kind: '观点', confidence: 0.9 },
      null,
      'not-an-object',
      42,
      { concept: 'B', claim: 'b', kind: '事实', confidence: '0.8' },
      { concept: 'C', claim: 'c', kind: '数据', confidence: NaN },
    ])
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ concept: 'A', claim: 'a', kind: '观点', confidence: 0.9 })
    expect(out[1]).toEqual({ concept: 'B', claim: 'b', kind: '事实', confidence: null })
    expect(out[2]).toEqual({ concept: 'C', claim: 'c', kind: '数据', confidence: null })
  })

  it('写入→读出的往返无损（快照格式不与内存格式漂移）', () => {
    const units = [
      unit({ id: 'a', concept: '留存', claim: '首日体验决定留存', kind: '观点', confidence: 0.82 }),
      unit({ id: 'b', concept: '选题', claim: '垂直优于泛流量', kind: '经历', confidence: 0.66 }),
    ]
    // 模拟真链路：summarize → jsonb 落库 → 解析回来
    const roundTrip = normalizeInjectedUnits(
      JSON.parse(JSON.stringify(summarizeInjectedUnits(units)))
    )
    expect(roundTrip).toEqual(summarizeInjectedUnits(units))
  })
})

describe('fetchInjectableUnits（读取与降级）', () => {
  it('返回已确认且置信度达标的单元', async () => {
    const units = await fetchInjectableUnits(mockClient({ data: [row()] }), 'user-1')
    expect(units).toHaveLength(1)
    expect(units[0]?.concept).toBe('AI 与教育')
  })

  it('候选状态即使在结果里也被剔除（候选→确认只能由用户完成）', async () => {
    const units = await fetchInjectableUnits(
      mockClient({ data: [row({ status: '候选' })] }),
      'user-1'
    )
    expect(units).toEqual([])
  })

  it('置信度不足阈值被剔除', async () => {
    const units = await fetchInjectableUnits(
      mockClient({ data: [row({ confidence: 0.59 })] }),
      'user-1'
    )
    expect(units).toEqual([])
  })

  it('表未迁移（42P01）→ 空数组，不阻断生成', async () => {
    const units = await fetchInjectableUnits(
      mockClient({ error: { code: '42P01', message: 'relation does not exist' } }),
      'user-1'
    )
    expect(units).toEqual([])
  })

  it('其它错误 → 空数组并记录日志', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const units = await fetchInjectableUnits(
      mockClient({ error: { code: '42501', message: 'permission denied' } }),
      'user-1'
    )
    expect(units).toEqual([])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('data 为空/非数组 → 空数组', async () => {
    expect(await fetchInjectableUnits(mockClient({ data: null }), 'u')).toEqual([])
    expect(await fetchInjectableUnits(mockClient({ data: 'oops' }), 'u')).toEqual([])
  })

  it('查询抛异常 → 空数组', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bad = { from: () => { throw new Error('boom') } } as unknown as SupabaseClient
    expect(await fetchInjectableUnits(bad, 'u')).toEqual([])
    spy.mockRestore()
  })
})
