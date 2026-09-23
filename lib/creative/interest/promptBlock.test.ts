import { describe, it, expect } from 'vitest'
import {
  normalizeInterestProfile,
  formatInterestForPrompt,
  buildInterestBlock,
  type InterestProfileSnapshot,
} from './promptBlock'

/** 构造一份与 profileAssembly.assembleProfile 形态一致的画像 */
function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    identity: { completeness: 0.6, event_count_30d: 12 },
    core: [
      { cluster_id: 'c1', code: 'ai-edu', label: 'AI 教育', weight: 0.82, confidence: 0.7 },
      { cluster_id: 'c2', code: 'math', label: '数学思维', weight: 0.61, confidence: 0.6 },
    ],
    exploration: [],
    temporary: [],
    domains: { 教育: 0.55, 科技: 0.3, 商业: 0.15 },
    topic_interest: [
      { name: 'AI 教育', weight: 82, reason: '近 90 天 14 次相关行为，生成 5 篇，近期创作与互动持续升温' },
      { name: '数学思维', weight: 61, reason: '近 90 天 6 次相关行为，稳定的创作主题' },
      { name: '长尾噪声', weight: 2, reason: '低频' },
    ],
    content_preference: { likes: ['AI 教育'], dislikes: ['空洞鸡汤'] },
    creative_goals: ['做出有深度的教育内容'],
    recent_creation_direction: { code: 'ai-edu', label: 'AI 教育', recentEvents: 5 },
    behavior_reason_summary: { window_days: 90, mix: { genuine_interest: 0.7 } },
    ...overrides,
  }
}

describe('normalizeInterestProfile', () => {
  it('未建模的空画像返回 null，不注入任何内容', () => {
    expect(normalizeInterestProfile({})).toBeNull()
    expect(normalizeInterestProfile(null)).toBeNull()
    expect(normalizeInterestProfile(undefined)).toBeNull()
    expect(normalizeInterestProfile('not an object')).toBeNull()
  })

  it('完整画像解析出主题、核心层、近期方向与领域分布', () => {
    const snap = normalizeInterestProfile(makeProfile())
    expect(snap).not.toBeNull()
    expect(snap!.topicInterest).toHaveLength(3)
    expect(snap!.topicInterest[0]).toEqual({
      name: 'AI 教育',
      weight: 82,
      reason: '近 90 天 14 次相关行为，生成 5 篇，近期创作与互动持续升温',
    })
    expect(snap!.coreLabels).toEqual(['AI 教育', '数学思维'])
    expect(snap!.recentDirection).toEqual({ code: 'ai-edu', label: 'AI 教育', recentEvents: 5 })
    // 领域按占比降序
    expect(snap!.domains.map((d) => d.name)).toEqual(['教育', '科技', '商业'])
    expect(snap!.schemaVersion).toBe(2)
  })

  it('无名称的主题被丢弃，避免脏数据进入 prompt', () => {
    const snap = normalizeInterestProfile(
      makeProfile({ topic_interest: [{ name: '', weight: 90 }, { name: '   ', weight: 90 }] })
    )
    // 领域分布仍在，故画像本身不算未建模；但主题列表必须为空
    expect(snap!.topicInterest).toEqual([])
  })

  it('无名称主题且无领域分布时整体视为未建模', () => {
    const snap = normalizeInterestProfile(
      makeProfile({
        topic_interest: [{ name: '', weight: 90 }],
        domains: {},
        core: [],
      })
    )
    expect(snap).toBeNull()
  })

  it('权重与串长被夹到安全区间', () => {
    const snap = normalizeInterestProfile(
      makeProfile({
        topic_interest: [
          { name: 'x'.repeat(200), weight: 999, reason: 'r'.repeat(500) },
          { name: '正常', weight: -50, reason: '' },
        ],
      })
    )
    expect(snap!.topicInterest[0].name).toHaveLength(40)
    expect(snap!.topicInterest[0].weight).toBe(100)
    expect(snap!.topicInterest[0].reason).toHaveLength(120)
    expect(snap!.topicInterest[1].weight).toBe(0)
  })

  it('仅有领域分布、无主题兴趣时仍视为已建模', () => {
    const snap = normalizeInterestProfile(makeProfile({ topic_interest: [] }))
    expect(snap).not.toBeNull()
    expect(snap!.domains.length).toBeGreaterThan(0)
  })

  it('主题兴趣缺失且领域为空时返回 null', () => {
    const snap = normalizeInterestProfile(makeProfile({ topic_interest: [], domains: {} }))
    expect(snap).toBeNull()
  })
})

describe('formatInterestForPrompt', () => {
  it('未建模画像输出空串', () => {
    expect(formatInterestForPrompt(null)).toBe('')
    expect(formatInterestForPrompt(normalizeInterestProfile({}))).toBe('')
  })

  it('输出包含长期关注、稳定深耕、近期方向与领域分布', () => {
    const text = formatInterestForPrompt(normalizeInterestProfile(makeProfile()))
    expect(text).toContain('【该创作者的长期关注领域】')
    expect(text).toContain('长期关注：')
    expect(text).toContain('AI 教育（强度 82/100')
    expect(text).toContain('稳定深耕：AI 教育、数学思维')
    expect(text).toContain('近期方向：AI 教育（近 7 天 5 次相关行为）')
    expect(text).toContain('领域分布：教育 55%，科技 30%，商业 15%')
  })

  it('默认过滤掉弱噪声主题（强度 < 5）', () => {
    const text = formatInterestForPrompt(normalizeInterestProfile(makeProfile()))
    expect(text).not.toContain('长尾噪声')
  })

  it('明确告知模型这是软参考而非硬命题', () => {
    const text = formatInterestForPrompt(normalizeInterestProfile(makeProfile()))
    expect(text).toContain('不得当成硬性命题')
    expect(text).toContain('忽略本块即可')
  })

  it('尊重 maxTopics 条数上限', () => {
    const profile = makeProfile({
      topic_interest: Array.from({ length: 10 }, (_, i) => ({
        name: '主题' + i,
        weight: 90 - i,
      })),
    })
    const text = formatInterestForPrompt(normalizeInterestProfile(profile), { maxTopics: 3 })
    expect(text).toContain('主题0')
    expect(text).toContain('主题2')
    expect(text).not.toContain('主题3')
  })

  it('超出字符预算时按行截断且不丢标题', () => {
    const profile = makeProfile({
      topic_interest: Array.from({ length: 10 }, (_, i) => ({
        name: '这是一个很长的主题名称' + i,
        weight: 90 - i,
        reason: '这是一段很长的行为理由描述文字，用来撑爆预算' + i,
      })),
    })
    const budget = 300
    const text = formatInterestForPrompt(normalizeInterestProfile(profile), {
      maxLength: budget,
    })
    // 用法说明行固定附加，单独校验主体部分不超预算
    const body = text.split('\n用法：')[0]
    expect(body.length).toBeLessThanOrEqual(budget)
    expect(body.startsWith('【该创作者的长期关注领域】')).toBe(true)
  })

  it('只有领域分布时也能产出文本', () => {
    const snap = normalizeInterestProfile(makeProfile({ topic_interest: [], core: [] }))
    const text = formatInterestForPrompt(snap)
    expect(text).toContain('领域分布：')
    expect(text).not.toContain('长期关注：')
  })
})

describe('buildInterestBlock', () => {
  it('一次性返回文本与快照，便于回传证据层', () => {
    const { text, snapshot } = buildInterestBlock(makeProfile())
    expect(text).toContain('AI 教育')
    expect(snapshot?.completeness).toBeCloseTo(0.6)
  })

  it('脏输入不抛异常且返回空文本', () => {
    const { text, snapshot } = buildInterestBlock('garbage')
    expect(text).toBe('')
    expect(snapshot).toBeNull()
  })

  it('快照可直接驱动相关性粗筛（供后续 Phase 3 复用）', () => {
    const { snapshot } = buildInterestBlock(makeProfile())
    expect(snapshot!.topicInterest.some((t) => t.name === 'AI 教育')).toBe(true)
    expect(snapshot!.topicInterest.every((t) => t.weight >= 0 && t.weight <= 100)).toBe(true)
  })
})

describe('快照类型契约', () => {
  it('字段满足 InterestProfileSnapshot 结构', () => {
    const snap: InterestProfileSnapshot | null = normalizeInterestProfile(makeProfile())
    expect(Object.keys(snap!).sort()).toEqual(
      [
        'completeness',
        'coreLabels',
        'domains',
        'recentDirection',
        'schemaVersion',
        'topicInterest',
      ].sort()
    )
  })
})
