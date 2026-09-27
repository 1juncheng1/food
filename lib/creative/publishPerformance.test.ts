import { describe, expect, it } from 'vitest'
import { computePublishPerformance, type PublishFact } from './publishPerformance'

const NOW = new Date('2026-09-24T00:00:00.000Z')

function fact(partial: Partial<PublishFact> & { id: string }): PublishFact {
  return {
    category: '未分类',
    tags: [],
    likes: 0,
    saves: 0,
    comments: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...partial,
  }
}

const FACTS: PublishFact[] = [
  fact({ id: '1', category: 'AI 教育', tags: ['教育', 'AI'], likes: 30, saves: 20, comments: 5 }),
  fact({ id: '2', category: 'AI 教育', tags: ['教育', 'AI'], likes: 20, saves: 15, comments: 3 }),
  fact({ id: '3', category: 'AI 教育', tags: ['教育'], likes: 10, saves: 5, comments: 2 }),
  fact({ id: '4', category: '随笔', tags: ['生活'], likes: 2, saves: 0, comments: 0 }),
]

describe('computePublishPerformance 空值与降级', () => {
  it('没有已发布作品：全 0 且给出诚实说明（不输出看似精致的空排名）', () => {
    const r = computePublishPerformance([], NOW)
    expect(r.publishedCount).toBe(0)
    expect(r.confidence).toBe(0)
    expect(r.bestCategory).toBeNull()
    expect(r.caveat).toContain('尚无任何已发布作品')
  })

  it('脏数据（null 分类 / 非数字计数）不抛异常', () => {
    const r = computePublishPerformance(
      [fact({ id: 'x', category: undefined as unknown as string, likes: Number.NaN })],
      NOW
    )
    expect(r.publishedCount).toBe(1)
    expect(Number.isFinite(r.perPostAvg.likes)).toBe(true)
  })
})

describe('computePublishPerformance 总量事实', () => {
  it('总量与篇均计算正确', () => {
    const r = computePublishPerformance(FACTS, NOW)
    expect(r.totals.likes).toBe(62)
    expect(r.totals.interactions).toBe(62 + 40 + 10)
    expect(r.perPostAvg.interactions).toBe(28)
  })

  it('保存率区分"被喜欢"与"被需要"；无互动时为 0 而非 NaN', () => {
    const r = computePublishPerformance(FACTS, NOW)
    expect(r.saveRatio).toBeCloseTo(40 / 112, 2)

    const zero = computePublishPerformance([fact({ id: 'z' })], NOW)
    expect(zero.saveRatio).toBe(0)
    expect(zero.commentRatio).toBe(0)
  })
})

describe('computePublishPerformance 归因必须过样本门槛', () => {
  it('样本不足时只给总量，不给"你适合写什么"', () => {
    const r = computePublishPerformance(FACTS.slice(0, 2), NOW)
    expect(r.byCategory).toEqual([])
    expect(r.byTag).toEqual([])
    expect(r.bestCategory).toBeNull()
    expect(r.caveat).toContain('低于归因门槛')
  })

  it('达到门槛（≥3 篇）才归因，且只认显著条目', () => {
    const r = computePublishPerformance(FACTS, NOW)
    expect(r.bestCategory?.name).toBe('AI 教育')
    expect(r.byCategory.map((c) => c.name)).not.toContain('随笔') // 仅 1 篇，不够门槛
    expect(r.byTag.map((t) => t.name)).toContain('教育')
  })

  it('有作品但零互动：说明无法判断差异，而不是给出全 0 排名', () => {
    const r = computePublishPerformance(
      [fact({ id: 'a' }), fact({ id: 'b' }), fact({ id: 'c' })],
      NOW
    )
    expect(r.caveat).toContain('没有任何互动')
    expect(r.byCategory).toEqual([])
  })
})

describe('computePublishPerformance 置信度', () => {
  it('样本越多置信度越高，且永不超过 1', () => {
    const few = computePublishPerformance(FACTS.slice(0, 3), NOW)
    const many = computePublishPerformance(
      Array.from({ length: 20 }, (_, i) =>
        fact({ id: `m${i}`, category: 'AI 教育', likes: 5 })
      ),
      NOW
    )
    expect(many.confidence).toBeGreaterThan(few.confidence)
    expect(many.confidence).toBeLessThanOrEqual(1)
  })

  it('陈旧样本压低置信度（发布是很久以前的事，不足以说明现在）', () => {
    const stale = computePublishPerformance(
      FACTS.map((f) => ({ ...f, createdAt: '2024-01-01T00:00:00.000Z' })),
      NOW
    )
    const fresh = computePublishPerformance(FACTS, NOW)
    expect(stale.confidence).toBeLessThan(fresh.confidence)
  })
})
