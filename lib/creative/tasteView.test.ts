import { describe, expect, it } from 'vitest'
import { buildTasteView, type TasteSource } from './tasteView'

const REPORT = {
  version: 2,
  updatedAt: '2026-09-01T00:00:00.000Z',
  sampleCount: 12,
  sources: { works: 8, materials: 4, signals: 6 },
  confidence: 0.7,
  personality: { main: '思考型创作者', sub: '', description: '长期输出深度内容' },
  bounds: { favorite: ['真实案例'], avoid: ['夸张标题'] },
  previous: null,
}

const EDITING = {
  preferences: [
    { type: 'like' as const, statement: '开头冲突', confidence: 0.6, sourceCount: 3, examples: [] },
    { type: 'avoid' as const, statement: '堆砌形容词', confidence: 0.5, sourceCount: 2, examples: [] },
    { type: 'avoid' as const, statement: '一次偶然的拒绝', confidence: 0.1, sourceCount: 1, examples: [] },
  ],
  samples: 6,
  updatedAt: '2026-09-01T00:00:00.000Z',
}

const INTEREST = {
  topic_interest: [
    { name: 'AI 教育', weight: 80, reason: '创作 6 篇' },
    { name: '边缘话题', weight: 10, reason: '创作 1 篇' },
  ],
  domains: {},
  identity: { completeness: 0.5 },
}

describe('buildTasteView 空值与降级', () => {
  it('全空输入：hasAny=false，不抛异常', () => {
    const v = buildTasteView({})
    expect(v.hasAny).toBe(false)
    expect(v.likes).toEqual([])
    expect(v.avoids).toEqual([])
    expect(v.depth).toBeNull()
  })

  it('脏数据一律按"没有"处理', () => {
    const v = buildTasteView({
      declaration: 'broken',
      report: 42,
      editingProfile: null,
      interestProfile: {},
      styleDimensions: 'x',
    })
    expect(v.hasAny).toBe(false)
  })
})

describe('buildTasteView 各路信号', () => {
  it('declaration 的排斥项是权威信号，不受置信度门槛限制', () => {
    const v = buildTasteView({
      declaration: { avoid_preference: '空洞鸡汤、流水账' },
    })
    expect(v.avoids.map((s) => s.statement).sort()).toEqual(['流水账', '空洞鸡汤'])
    expect(v.avoids.every((s) => s.sources.includes('declaration'))).toBe(true)
    expect(v.avoids.every((s) => s.confidence === 1)).toBe(true)
  })

  it('report 的 bounds 双向取值，置信度沿用报告自身', () => {
    const v = buildTasteView({ report: REPORT })
    expect(v.likes.map((s) => s.statement)).toContain('真实案例')
    expect(v.avoids.map((s) => s.statement)).toContain('夸张标题')
    expect(v.likes[0].confidence).toBeCloseTo(0.7, 5)
  })

  it('editing 样本 <2 不产出信号（与注入门槛同口径，单次行为不定性用户）', () => {
    const v = buildTasteView({
      editingProfile: { ...EDITING, samples: 1 },
    })
    expect(v.likes).toEqual([])
    expect(v.avoids).toEqual([])
  })

  it('低置信的行为信号被过滤（真实定稿率仅 7%，防止一次拒绝定性用户）', () => {
    const v = buildTasteView({ editingProfile: EDITING })
    expect(v.avoids.map((s) => s.statement)).toContain('堆砌形容词')
    expect(v.avoids.map((s) => s.statement)).not.toContain('一次偶然的拒绝')
  })

  it('兴趣强度过低不视为"喜欢"（长期关注 ≠ 喜欢，且要滤长尾）', () => {
    const v = buildTasteView({ interestProfile: INTEREST })
    expect(v.likes.map((s) => s.statement)).toContain('AI 教育')
    expect(v.likes.map((s) => s.statement)).not.toContain('边缘话题')
  })
})

describe('buildTasteView 多源合并', () => {
  it('同一陈述被多路印证时合并为一条，来源并列、置信度叠加', () => {
    const v = buildTasteView({
      report: REPORT,
      editingProfile: {
        preferences: [
          { type: 'avoid', statement: '夸张标题', confidence: 0.5, sourceCount: 2, examples: [] },
        ],
        samples: 4,
      },
    })
    const signal = v.avoids.find((s) => s.statement === '夸张标题')!
    expect(signal.sources.sort()).toEqual(['editing', 'report'])
    // noisy-OR：0.7 与 0.5 合并为 0.85 —— 强于任一单源，但永不到 1
    // （创作口味持续演化，任何置信度都不该表现为确证）
    expect(signal.confidence).toBeCloseTo(0.85, 5)
    expect(signal.confidence).toBeGreaterThan(0.7)
    expect(signal.confidence).toBeLessThan(1)
    // 证据说明要能追溯到每一路
    expect(signal.evidence).toContain('拒绝过')
    expect(signal.evidence).toContain('12 篇作品')
  })

  it('用户声明参与合并时直接拉满（用户亲口说的就是事实，不需要攒样本）', () => {
    const v = buildTasteView({
      declaration: { avoid_preference: '夸张标题' },
      editingProfile: {
        preferences: [
          { type: 'avoid', statement: '夸张标题', confidence: 0.5, sourceCount: 2, examples: [] },
        ],
        samples: 4,
      },
    })
    const signal = v.avoids.find((s) => s.statement === '夸张标题')!
    expect(signal.confidence).toBe(1)
    expect(signal.evidence).toContain('明确排除')
  })

  it('来源标签齐全，UI 可逐条追溯出处', () => {
    const v = buildTasteView({
      declaration: { avoid_preference: '空洞鸡汤' },
      report: REPORT,
      editingProfile: EDITING,
      interestProfile: INTEREST,
    })
    const sources = new Set<TasteSource>(
      [...v.likes, ...v.avoids].flatMap((s) => s.sources)
    )
    expect(sources.has('declaration')).toBe(true)
    expect(sources.has('report')).toBe(true)
    expect(sources.has('editing')).toBe(true)
    expect(sources.has('interest')).toBe(true)
  })
})

describe('buildTasteView 深度取向', () => {
  it('五维均值派生深度，样本不足时为 null', () => {
    expect(
      buildTasteView({ styleDimensions: { dims: { opening: 0.8 }, samples: 1 } }).depth
    ).toBeNull()

    const deep = buildTasteView({
      styleDimensions: { dims: { opening: 0.8, structure: 0.8 }, samples: 6 },
    }).depth!
    expect(deep.label).toBe('偏深入')

    const plain = buildTasteView({
      styleDimensions: { dims: { opening: 0.2, structure: 0.3 }, samples: 6 },
    }).depth!
    expect(plain.label).toBe('偏平实')
  })
})
