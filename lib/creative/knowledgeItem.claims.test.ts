import { describe, it, expect } from 'vitest'
import {
  normalizeClaims,
  normalizeKnowledgeItem,
  CLAIM_KINDS,
  CLAIM_KIND_LABELS,
} from './knowledgeItem'

describe('normalizeClaims', () => {
  it('非数组 / 脏输入一律返回空数组，不抛异常', () => {
    expect(normalizeClaims(undefined)).toEqual([])
    expect(normalizeClaims(null)).toEqual([])
    expect(normalizeClaims('not array')).toEqual([])
    expect(normalizeClaims([])).toEqual([])
    expect(normalizeClaims([null, 42, 'x', {}])).toEqual([])
  })

  it('保留完整合法主张，并带上全部语义字段', () => {
    const out = normalizeClaims([
      {
        text: 'AI 不会取代老师，而是把老师从重复劳动中解放出来',
        kind: '观点',
        confidence: 0.8,
        source: '素材明确表述',
        applicableScopes: ['AI 教育', '教育类内容'],
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      text: 'AI 不会取代老师，而是把老师从重复劳动中解放出来',
      kind: '观点',
      confidence: 0.8,
      source: '素材明确表述',
      applicableScopes: ['AI 教育', '教育类内容'],
    })
  })

  it('text 为空的主张被丢弃（缺了命题本体的 claim 毫无价值）', () => {
    expect(normalizeClaims([{ text: '', kind: '事实' }])).toEqual([])
    expect(normalizeClaims([{ text: '   ', kind: '事实' }])).toEqual([])
    expect(normalizeClaims([{ kind: '事实' }])).toEqual([])
  })

  it('非法 kind 兜底为"观点"，而不是丢弃', () => {
    expect(normalizeClaims([{ text: '某句断言', kind: '主张' }])[0].kind).toBe('观点')
    expect(normalizeClaims([{ text: '某句断言', kind: 123 }])[0].kind).toBe('观点')
    expect(normalizeClaims([{ text: '某句断言' }])[0].kind).toBe('观点')
  })

  it('全部四种合法 kind 都能通过', () => {
    for (const k of CLAIM_KINDS) {
      expect(normalizeClaims([{ text: '命题', kind: k }])[0].kind).toBe(k)
      expect(CLAIM_KIND_LABELS[k]).toBe(k)
    }
    expect(CLAIM_KINDS).toEqual(['事实', '数据', '观点', '经历'])
  })

  it('兼容 history 形状的 statement/type 别名', () => {
    const out = normalizeClaims([{ statement: '旧字段名写的主张', type: '数据' }])
    expect(out[0].text).toBe('旧字段名写的主张')
    expect(out[0].kind).toBe('数据')
  })

  it('confidence 越界被夹到 0-1，缺失或非数字时兜底 0.4', () => {
    const out = normalizeClaims([
      { text: 'a', confidence: 5 },
      { text: 'b', confidence: -3 },
      { text: 'c' },
      { text: 'd', confidence: 'not-a-number' },
    ])
    expect(out.map((c) => c.confidence)).toEqual([1, 0, 0.4, 0.4])
  })

  it('同一素材内按 text 去重', () => {
    const out = normalizeClaims([
      { text: '重复的话', kind: '事实' },
      { text: '重复的话', kind: '数据' },
      { text: '另一句', kind: '事实' },
    ])
    expect(out).toHaveLength(2)
    expect(out[0].kind).toBe('事实')
  })

  it('默认最多 5 条，超出丢弃（防止 LLM 把同一意思拆成多条）', () => {
    const input = Array.from({ length: 9 }, (_, i) => ({
      text: '命题' + i,
      kind: '事实' as const,
    }))
    expect(normalizeClaims(input)).toHaveLength(5)
    expect(normalizeClaims(input, 2)).toHaveLength(2)
  })

  it('applicableScopes 最多 3 个且过滤空串', () => {
    const out = normalizeClaims([{ text: 'p', applicableScopes: ['a', '', '  ', 'b', 'c', 'd'] }])
    expect(out[0].applicableScopes).toEqual(['a', 'b', 'c'])
  })

  it('source 为空时不写该字段，避免存一堆空字符串', () => {
    expect(normalizeClaims([{ text: 'p', source: '  ' }])[0].source).toBeUndefined()
  })

  it('text 超长被裁剪到 300 字', () => {
    expect(normalizeClaims([{ text: 'x'.repeat(500), kind: '事实' }])[0].text).toHaveLength(300)
  })
})

describe('normalizeKnowledgeItem 与 claims 的协作', () => {
  const baseKnowledge = {
    meaning: '讨论 AI 与教育的关系',
    context: '适用于教育类内容',
    content_type: '观点素材',
    content_tags: ['教育'],
    usage_tags: ['观点素材'],
    confidence: 0.8,
    analyzed_at: '2026-09-22T00:00:00.000Z',
  }

  it('带 claims 的知识项保留 claims', () => {
    const item = normalizeKnowledgeItem({
      ...baseKnowledge,
      claims: [{ text: '数学培养抽象思维', kind: '观点', confidence: 0.7 }],
    })
    expect(item?.claims).toHaveLength(1)
    expect(item?.claims?.[0].text).toBe('数学培养抽象思维')
  })

  it('无 claims 时不写入该字段，保持向后兼容的旧数据形状', () => {
    expect(normalizeKnowledgeItem(baseKnowledge)?.claims).toBeUndefined()
  })

  it('claims 全为脏数据时等同于没有 claims', () => {
    const item = normalizeKnowledgeItem({ ...baseKnowledge, claims: [{ kind: '事实' }] })
    expect(item?.claims).toBeUndefined()
  })

  it('历史数据没有 claims 字段时不影响清洗结果', () => {
    const item = normalizeKnowledgeItem(baseKnowledge)
    expect(item?.confidence).toBe(0.8)
    expect(item?.content_tags).toEqual(['教育'])
  })
})
