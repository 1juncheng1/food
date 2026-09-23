import { describe, it, expect } from 'vitest'
import {
  CLAIM_KINDS,
  type ClaimKind,
  type KnowledgeClaim,
} from './knowledgeItem'
import {
  KNOWLEDGE_STATUSES,
  MIN_SOURCES_FOR_UNIT,
  normalizeCandidateUnit,
  normalizeKnowledgeUnit,
  isUnitInjectable,
  mergeSources,
  DEFAULT_KNOWLEDGE_STATUS,
} from './knowledgeUnit'
import { groupClaims, type ClaimRef } from './knowledgeAggregator'

function claim(
  text: string,
  opts: Partial<Omit<KnowledgeClaim, 'text'>> = {}
): KnowledgeClaim {
  return {
    text,
    kind: '观点',
    confidence: 0.7,
    ...opts,
  }
}

describe('normalizeCandidateUnit', () => {
  const valid = {
    concept: 'AI 与教育',
    claim: 'AI 不会取代老师，而是把老师从重复劳动中解放出来',
    kind: '观点',
    confidence: 0.8,
    sourceItemIds: ['id-1', 'id-2'],
  }

  it('保留完整合法候选', () => {
    expect(normalizeCandidateUnit(valid)).toEqual({
      concept: 'AI 与教育',
      claim: 'AI 不会取代老师，而是把老师从重复劳动中解放出来',
      kind: '观点',
      domainScope: [],
      confidence: 0.8,
      sourceItemIds: ['id-1', 'id-2'],
    })
  })

  it('非对象输入返回 null', () => {
    expect(normalizeCandidateUnit(null)).toBeNull()
    expect(normalizeCandidateUnit('x')).toBeNull()
    expect(normalizeCandidateUnit([])).toBeNull()
  })

  it('concept 或 claim 缺失 → null（聚合键与命题本体缺一不可）', () => {
    expect(normalizeCandidateUnit({ ...valid, concept: '' })).toBeNull()
    expect(normalizeCandidateUnit({ ...valid, claim: '   ' })).toBeNull()
    expect(normalizeCandidateUnit({ claim: 'x', sourceItemIds: ['a', 'b'] })).toBeNull()
  })

  it('来源不足 MIN_SOURCES_FOR_UNIT → null：单来源不配叫跨素材归纳', () => {
    expect(MIN_SOURCES_FOR_UNIT).toBe(2)
    expect(normalizeCandidateUnit({ ...valid, sourceItemIds: [] })).toBeNull()
    expect(normalizeCandidateUnit({ ...valid, sourceItemIds: ['id-1'] })).toBeNull()
  })

  it('重复来源先去重后再判定数量 —— 同素材出现两次不算两条独立来源', () => {
    expect(
      normalizeCandidateUnit({ ...valid, sourceItemIds: ['id-1', 'id-1'] })
    ).toBeNull()
  })

  it('兼容 name/statement/source_item_ids 别名（LLM 输出不稳定）', () => {
    const out = normalizeCandidateUnit({
      name: '旧字段概念',
      statement: '旧字段命题',
      type: '数据',
      source_item_ids: ['a', 'b'],
    })
    expect(out?.concept).toBe('旧字段概念')
    expect(out?.claim).toBe('旧字段命题')
    expect(out?.kind).toBe('数据')
    expect(out?.sourceItemIds).toEqual(['a', 'b'])
  })

  it('非法 kind 兜底为「观点」', () => {
    expect(normalizeCandidateUnit({ ...valid, kind: '主张' })?.kind).toBe('观点')
    expect(normalizeCandidateUnit({ ...valid, kind: 42 })?.kind).toBe('观点')
  })

  it('全部合法 kind 通过', () => {
    for (const k of CLAIM_KINDS) {
      expect(normalizeCandidateUnit({ ...valid, kind: k })?.kind).toBe(k)
    }
  })

  it('confidence 越界被夹到 0-1，非数字兜底 0.5', () => {
    expect(normalizeCandidateUnit({ ...valid, confidence: 9 })?.confidence).toBe(1)
    expect(normalizeCandidateUnit({ ...valid, confidence: -1 })?.confidence).toBe(0)
    expect(normalizeCandidateUnit({ ...valid, confidence: 'x' })?.confidence).toBe(0.5)
  })

  it('domainScope 去重并截断到 5 个', () => {
    const out = normalizeCandidateUnit({
      ...valid,
      domainScope: ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
    })
    expect(out?.domainScope).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('groupClaims（阶段 A 分桶）', () => {
  it('相同场景 + 相同种类的主张跨≥2 素材才成组', () => {
    const refs: ClaimRef[] = [
      { itemId: 'm1', claim: claim('换个视角看问题', { applicableScopes: ['思维方式'] }) },
      { itemId: 'm2', claim: claim('争执往往源于站位', { applicableScopes: ['思维方式'] }) },
    ]
    const groups = groupClaims(refs)
    expect(groups).toHaveLength(1)
    expect(groups[0].scope).toBe('思维方式')
    expect(groups[0].itemIds.sort()).toEqual(['m1', 'm2'])
  })

  it('只有一条来源的素材组被丢弃 —— 那只是素材层的 claim', () => {
    const refs: ClaimRef[] = [
      { itemId: 'm1', claim: claim('孤例主张', { applicableScopes: ['思维方式'] }) },
    ]
    expect(groupClaims(refs)).toEqual([])
  })

  it('同一素材重复落同一场景仍算一个来源（防止自引撑起一个组）', () => {
    const refs: ClaimRef[] = [
      { itemId: 'm1', claim: claim('A', { applicableScopes: ['S'] }) },
      { itemId: 'm1', claim: claim('B', { applicableScopes: ['S'] }) },
    ]
    expect(groupClaims(refs)).toEqual([])
  })

  it('同场景不同 kind 必须分开成组 —— 数据与观点的引用规则不同', () => {
    const refs: ClaimRef[] = [
      { itemId: 'm1', claim: claim('数据说法', { kind: '数据', applicableScopes: ['教育'] }) },
      { itemId: 'm2', claim: claim('另一组数据', { kind: '数据', applicableScopes: ['教育'] }) },
      { itemId: 'm1', claim: claim('立场表达', { kind: '观点', applicableScopes: ['教育'] }) },
      { itemId: 'm2', claim: claim('另一立场', { kind: '观点', applicableScopes: ['教育'] }) },
    ]
    const groups = groupClaims(refs)
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.kind).sort()).toEqual(['数据', '观点'])
  })

  it('场景总数达标还不够，必须每个 kind 各自满足来源数', () => {
    const refs: ClaimRef[] = [
      { itemId: 'm1', claim: claim('A', { kind: '观点', applicableScopes: ['S'] }) },
      { itemId: 'm2', claim: claim('B', { kind: '观点', applicableScopes: ['S'] }) },
      // 只有一条来源的数据主张 → 该 kind 不成组
      { itemId: 'm1', claim: claim('C', { kind: '数据', applicableScopes: ['S'] }) },
    ]
    const groups = groupClaims(refs)
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('观点')
  })

  it('无适用场景的主张被跳过，不进通配桶（否则不相关内容会因「都没分类」聚在一起）', () => {
    const refs: ClaimRef[] = [
      { itemId: 'm1', claim: claim('没标明场景', {}) },
      { itemId: 'm2', claim: claim('另一条没标明场景', {}) },
    ]
    expect(groupClaims(refs)).toEqual([])
  })

  it('一条主张带多个场景时进入多个分组', () => {
    const refs: ClaimRef[] = [
      { itemId: 'm1', claim: claim('跨界说法', { applicableScopes: ['A', 'B'] }) },
      { itemId: 'm2', claim: claim('呼应说法', { applicableScopes: ['A', 'B'] }) },
    ]
    expect(groupClaims(refs).map((g) => g.scope).sort()).toEqual(['A', 'B'])
  })

  it('按跨素材广度降序返回', () => {
    const refs: ClaimRef[] = []
    // S1：3 条素材；S2：2 条素材
    for (const id of ['m1', 'm2', 'm3']) {
      refs.push({ itemId: id, claim: claim(`S1-${id}`, { applicableScopes: ['S1'] }) })
    }
    for (const id of ['m1', 'm2']) {
      refs.push({ itemId: id, claim: claim(`S2-${id}`, { applicableScopes: ['S2'] }) })
    }
    const groups = groupClaims(refs)
    expect(groups.map((g) => g.scope)).toEqual(['S1', 'S2'])
  })

  it('maxGroups 截断，maxClaimsPerGroup 限制单组规模', () => {
    const refs: ClaimRef[] = []
    for (const id of ['m1', 'm2']) {
      for (const sc of ['S1', 'S2', 'S3']) {
        refs.push({ itemId: id, claim: claim(`${sc}-${id}`, { applicableScopes: [sc] }) })
      }
    }
    expect(groupClaims(refs, { maxGroups: 2 })).toHaveLength(2)

    // 单组 claim 超量时截断
    const many: ClaimRef[] = []
    for (const id of ['m1', 'm2']) {
      for (let i = 0; i < 20; i++) {
        many.push({ itemId: id, claim: claim(`t${i}-${id}`, { applicableScopes: ['S'] }) })
      }
    }
    expect(groupClaims(many, { maxClaimsPerGroup: 5 })[0].claims).toHaveLength(5)
  })

  it('空输入返回空数组', () => {
    expect(groupClaims([])).toEqual([])
  })
})

describe('normalizeKnowledgeUnit（读库行）', () => {
  const row = {
    id: 'unit-1',
    user_id: 'user-1',
    concept: 'AI 与教育',
    claim: 'AI 不会取代老师',
    kind: '事实' as ClaimKind,
    domain_scope: ['教育', 'AI'],
    confidence: 0.8,
    status: '已确认',
    source_item_ids: ['m1', 'm2'],
    source_count: 2,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-02T00:00:00.000Z',
    confirmed_at: '2026-09-02T00:00:00.000Z',
  }

  it('snake_case 库行映射为驼峰类型', () => {
    const u = normalizeKnowledgeUnit(row)!
    expect(u.id).toBe('unit-1')
    expect(u.userId).toBe('user-1')
    expect(u.domainScope).toEqual(['教育', 'AI'])
    expect(u.status).toBe('已确认')
    expect(u.sourceCount).toBe(2)
    expect(u.confirmedAt).toBe('2026-09-02T00:00:00.000Z')
  })

  it('缺 id / user_id → null', () => {
    expect(normalizeKnowledgeUnit({ ...row, id: '' })).toBeNull()
    expect(normalizeKnowledgeUnit({ ...row, user_id: undefined })).toBeNull()
  })

  it('非法 status 兜底为候选（不敢默认放行）', () => {
    expect(normalizeKnowledgeUnit({ ...row, status: '乱写' })?.status).toBe(DEFAULT_KNOWLEDGE_STATUS)
    expect(DEFAULT_KNOWLEDGE_STATUS).toBe('候选')
  })

  it('source_count 缺失时用来源数组长度兜底', () => {
    const u = normalizeKnowledgeUnit({ ...row, source_count: undefined })!
    expect(u.sourceCount).toBe(2)
  })

  it('全部合法状态通过', () => {
    for (const st of KNOWLEDGE_STATUSES) {
      expect(normalizeKnowledgeUnit({ ...row, status: st })?.status).toBe(st)
    }
    expect(KNOWLEDGE_STATUSES).toEqual(['候选', '已确认', '已拒绝', '已过期'])
  })
})

describe('注入与合并', () => {
  const base = {
    id: 'u1',
    userId: 'user-1',
    concept: 'C',
    claim: '命题',
    kind: '事实' as ClaimKind,
    domainScope: [],
    confidence: 0.8,
    sourceItemIds: ['m1', 'm2'],
    sourceCount: 2,
    status: '已确认' as const,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }

  it('只有「已确认 + 置信度达标」才能注入：AI 的归纳未经确认不放行', () => {
    expect(isUnitInjectable(base)).toBe(true)
    expect(isUnitInjectable({ ...base, status: '候选' })).toBe(false)
    expect(isUnitInjectable({ ...base, status: '已拒绝' })).toBe(false)
    expect(isUnitInjectable({ ...base, status: '已过期' })).toBe(false)
  })

  it('置信度低于阈值，即使已确认也不注入', () => {
    expect(isUnitInjectable({ ...base, confidence: 0.59 })).toBe(false)
    expect(isUnitInjectable({ ...base, confidence: 0.6 })).toBe(true)
  })

  it('mergeSources 只并来源，不动用户已确认的命题', () => {
    const merged = mergeSources(base, {
      concept: 'C',
      claim: '不应覆盖用户确认过的命题',
      kind: '事实',
      domainScope: [],
      confidence: 0.2,
      sourceItemIds: ['m2', 'm3'],
    })
    expect(merged.sort()).toEqual(['m1', 'm2', 'm3'])
  })
})
