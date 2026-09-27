import { describe, expect, it } from 'vitest'
import {
  LAYER_WEIGHTS,
  readCreatorUnderstanding,
  type UnderstandingInput,
} from './creatorUnderstanding'

function report(sampleCount = 12, confidence = 0.7) {
  return {
    version: 1,
    updatedAt: '2026-09-01T00:00:00.000Z',
    sampleCount,
    sources: { works: 8, materials: 4, signals: 6 },
    confidence,
    personality: { main: '思考型创作者', sub: '', description: '长期输出深度内容' },
    previous: null,
  }
}

const DECLARATION = {
  creator_goal: '分享',
  expression_profile: '深入分析',
  thinking_profile: '案例支撑',
  narrative_preference: '分析式',
  emotional_preference: '冷峻',
  quality_standard: '让人思考',
  avoid_preference: '空洞鸡汤',
  creation_scenario: '文章',
  interviewedAt: '2026-08-01T00:00:00.000Z',
  source: 'onboarding',
}

const INTEREST = {
  topic_interest: [{ name: 'AI 教育', weight: 80, reason: '创作 6 篇' }],
  core: [{ label: 'AI 教育' }],
  domains: { 'AI 教育': 0.6 },
  identity: { completeness: 0.5 },
  schema_version: 1,
}

describe('readCreatorUnderstanding 基础口径', () => {
  it('空输入：全部未就绪，理解度 0，缺口指向权重最高的 memory', () => {
    const s = readCreatorUnderstanding({})
    expect(s.percent).toBe(0)
    expect(s.readiness).toBe(0)
    expect(s.level).toBe('forming')
    expect(s.layers.every((l) => !l.present)).toBe(true)
    expect(s.nextGap).toBe('memory')
    expect(s.nextGapHint).toContain('访谈')
  })

  it('脏数据（null / 字符串 / 空对象）一律按"没有"处理，不抛异常不返回 NaN', () => {
    const s = readCreatorUnderstanding({
      declaration: 'not-an-object',
      report: null,
      interestProfile: {},
      styleDimensions: 'broken',
      editingProfile: 42,
      confirmedKnowledge: Number.NaN,
    })
    expect(s.percent).toBe(0)
    expect(Number.isFinite(s.readiness)).toBe(true)
  })

  it('权重合计为 1（防止有人加了一路却忘了配平）', () => {
    const sum = Object.values(LAYER_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9)
  })
})

describe('readCreatorUnderstanding 各路置信度', () => {
  it('declaration 按填满维度数计置信度（8 维填满 = 1）', () => {
    const half: UnderstandingInput = {
      declaration: {
        creator_goal: '分享',
        expression_profile: '深入分析',
        thinking_profile: '案例支撑',
        narrative_preference: '分析式',
      },
    }
    const s = readCreatorUnderstanding(half)
    const memory = s.layers.find((l) => l.key === 'memory')!
    expect(memory.present).toBe(true)
    expect(memory.confidence).toBeCloseTo(4 / 8, 5)

    const full = readCreatorUnderstanding({ declaration: DECLARATION })
    expect(full.layers.find((l) => l.key === 'memory')!.confidence).toBe(1)
  })

  it('report 采用报告自身的代码算置信度，present 由结构完整性决定', () => {
    const s = readCreatorUnderstanding({ report: report(12, 0.7) })
    const layer = s.layers.find((l) => l.key === 'report')!
    expect(layer.present).toBe(true)
    expect(layer.confidence).toBeCloseTo(0.7, 5)
    expect(layer.samples).toBe(12)
  })

  it('style / editing 样本 < 2 视为未就绪（与注入门槛同口径）', () => {
    const s = readCreatorUnderstanding({
      styleDimensions: { dims: { opening: 0.6 }, samples: 1 },
      editingProfile: { preferences: [], samples: 1 },
    })
    expect(s.layers.find((l) => l.key === 'style')!.present).toBe(false)
    expect(s.layers.find((l) => l.key === 'editing')!.present).toBe(false)
  })

  it('knowledge 按已确认条数计置信度，6 条封顶', () => {
    expect(readCreatorUnderstanding({ confirmedKnowledge: 3 }).layers.find((l) => l.key === 'knowledge')!.confidence).toBeCloseTo(0.5, 5)
    expect(readCreatorUnderstanding({ confirmedKnowledge: 99 }).layers.find((l) => l.key === 'knowledge')!.confidence).toBe(1)
  })
})

describe('readCreatorUnderstanding 综合与缺口引导', () => {
  it('六路齐全时达到 ready，且 nextGap 为 null', () => {
    const s = readCreatorUnderstanding({
      declaration: DECLARATION,
      report: report(20, 0.9),
      interestProfile: { ...INTEREST, identity: { completeness: 1 } },
      styleDimensions: { dims: {}, samples: 10 },
      editingProfile: { preferences: [], samples: 10 },
      confirmedKnowledge: 6,
    })
    expect(s.level).toBe('ready')
    expect(s.nextGap).toBeNull()
    expect(s.nextGapHint).toBeNull()
  })

  it('缺口按权重排序：memory 与 interest 都缺时先补 memory（0.24 > 0.20）', () => {
    const s = readCreatorUnderstanding({
      report: report(),
      styleDimensions: { dims: {}, samples: 5 },
    })
    expect(s.layers.find((l) => l.key === 'memory')!.present).toBe(false)
    expect(s.layers.find((l) => l.key === 'interest')!.present).toBe(false)
    expect(s.nextGap).toBe('memory')
  })

  it('新增「我是谁」三问不得让老用户理解度下降（系统升级不许转嫁给用户）', () => {
    const legacy = readCreatorUnderstanding({ declaration: DECLARATION })
    const withIdentity = readCreatorUnderstanding({
      declaration: { ...DECLARATION, background: '一线从业者' },
    })
    // 核心 8 维已填满者原本就是 1.0，补身份维度后仍是 1.0（不会变低）
    expect(legacy.layers.find((l) => l.key === 'memory')!.confidence).toBe(1)
    expect(withIdentity.percent).toBeGreaterThanOrEqual(legacy.percent)
  })

  it('身份三问对未填满核心维度的用户是真实加分', () => {
    const partial = { creator_goal: '分享', expression_profile: '深入分析' }
    const base = readCreatorUnderstanding({ declaration: partial })
    const boosted = readCreatorUnderstanding({
      declaration: { ...partial, background: '一线从业者' },
    })
    expect(
      boosted.layers.find((l) => l.key === 'memory')!.confidence
    ).toBeGreaterThan(base.layers.find((l) => l.key === 'memory')!.confidence)
  })

  it('理解度对"补数据"敏感：补齐 knowledge 后必须上升（指标要能检测改善）', () => {
    const base = readCreatorUnderstanding({
      declaration: DECLARATION,
      report: report(12, 0.7),
      interestProfile: INTEREST,
    })
    const improved = readCreatorUnderstanding({
      declaration: DECLARATION,
      report: report(12, 0.7),
      interestProfile: INTEREST,
      confirmedKnowledge: 4,
    })
    expect(improved.percent).toBeGreaterThan(base.percent)
  })
})
