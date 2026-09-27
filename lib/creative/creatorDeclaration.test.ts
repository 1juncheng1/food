import { describe, expect, it } from 'vitest'
import {
  CORE_DIMENSIONS,
  IDENTITY_DIMENSIONS,
  extractDeclarationTraits,
  formatDeclarationForPrompt,
  isDeclarationComplete,
  isDeclarationEmpty,
  missingIdentityDimensions,
  normalizeCreatorDeclaration,
  type CreatorDeclaration,
} from './creatorDeclaration'
import { shouldTriggerInterview } from './interviewTrigger'

/** 老用户：核心 8 维全填（2026-09-24 之前访谈完成的形态） */
const LEGACY_FULL: CreatorDeclaration = {
  creator_goal: '建立个人品牌',
  expression_profile: '深入分析背后逻辑',
  thinking_profile: '案例支撑',
  narrative_preference: '分析式',
  emotional_preference: '冷峻',
  quality_standard: '让人改变想法',
  avoid_preference: '空洞鸡汤',
  creation_scenario: '文章',
}

describe('「我是谁」三问：向后兼容', () => {
  it('新维度能被 normalize 读取（camelCase 与 snake_case 都兼容）', () => {
    const d = normalizeCreatorDeclaration({
      background: '一线从业者',
      value_statement: '真实胜过完美',
      long_term_goal: '个人影响力',
    })
    expect(d.background).toBe('一线从业者')
    expect(d.value_statement).toBe('真实胜过完美')
    expect(d.long_term_goal).toBe('个人影响力')
  })

  it('老数据（无新维度）normalize 后不凭空生成字段', () => {
    const d = normalizeCreatorDeclaration(LEGACY_FULL)
    expect(d.background).toBeUndefined()
    expect(d.value_statement).toBeUndefined()
    expect(d.long_term_goal).toBeUndefined()
  })

  it('核心维度仍是 8 个，身份维度是 3 个（扩维不许悄悄改判定分母）', () => {
    expect(CORE_DIMENSIONS).toHaveLength(8)
    expect(IDENTITY_DIMENSIONS).toHaveLength(3)
  })
})

describe('「我是谁」三问：不惩罚老用户', () => {
  it('核心 8 维填满即 complete —— 缺身份三问不算未完成', () => {
    expect(isDeclarationComplete(LEGACY_FULL)).toBe(true)
  })

  it('已访谈老用户不会被判成"未访谈"（isDeclarationEmpty 仍为 false）', () => {
    expect(isDeclarationEmpty(LEGACY_FULL)).toBe(false)
  })

  it('只填了身份三问也算有声明（不该被当成没数据而整块剔除）', () => {
    const onlyIdentity: CreatorDeclaration = { background: '一线从业者' }
    expect(isDeclarationEmpty(onlyIdentity)).toBe(false)
  })
})

describe('增量补问', () => {
  it('老用户：核心完整但缺身份三问 → 触发 supplement，且只补这 3 问', () => {
    const result = shouldTriggerInterview(LEGACY_FULL)
    expect(result.shouldTrigger).toBe(true)
    expect(result.triggerType).toBe('supplement')
    expect(result.missingDimensions).toEqual([
      'background',
      'value_statement',
      'long_term_goal',
    ])
  })

  it('补齐身份三问后不再触发（避免无限弹窗）', () => {
    const result = shouldTriggerInterview({
      ...LEGACY_FULL,
      background: '一线从业者',
      value_statement: '真实胜过完美',
      long_term_goal: '个人影响力',
    })
    expect(result.shouldTrigger).toBe(false)
  })

  it('新用户（空声明）仍是首次访谈，不是 supplement', () => {
    const result = shouldTriggerInterview(null)
    expect(result.triggerType).toBe('first_time')
  })

  it('missingIdentityDimensions 只返回没填的那些', () => {
    expect(missingIdentityDimensions({ ...LEGACY_FULL, background: '一线从业者' })).toEqual([
      'value_statement',
      'long_term_goal',
    ])
    expect(missingIdentityDimensions(LEGACY_FULL)).toHaveLength(3)
  })
})

describe('prompt 注入', () => {
  it('身份三问排在写法维度之前（先知道"谁在说话"再看"怎么说"）', () => {
    const text = formatDeclarationForPrompt({
      ...LEGACY_FULL,
      background: '一线从业者',
      value_statement: '真实胜过完美',
      long_term_goal: '个人影响力',
    })
    const iBackground = text.indexOf('经历与背景')
    const iValue = text.indexOf('价值判断')
    const iGoal = text.indexOf('创作目的')
    expect(iBackground).toBeGreaterThan(0)
    expect(iValue).toBeGreaterThan(iBackground)
    expect(iGoal).toBeGreaterThan(iValue)
  })

  it('只填身份三问也能注入（不整块剔除）', () => {
    const text = formatDeclarationForPrompt({ background: '一线从业者' })
    expect(text).toContain('一线从业者')
  })

  it('extractDeclarationTraits 覆盖身份维度，供前端展示"本次参考了什么"', () => {
    const traits = extractDeclarationTraits({
      ...LEGACY_FULL,
      background: '一线从业者',
    })
    expect(traits.map((t) => t.dimension)).toContain('经历与背景')
  })
})
