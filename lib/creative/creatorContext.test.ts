import { describe, expect, it } from 'vitest'
import { buildCreatorContextBlocks, type CreatorContextProfile } from './creatorContext'

const PROFILE: CreatorContextProfile = {
  tone_tags: ['冷静', '克制'],
  pace_preference: '偏慢',
  common_opening: '抛问题',
  avg_length: 1200,
  creator_personality: '思考型创作者',
  topic_preferences: ['AI 教育'],
  favorite_elements: ['真实案例'],
  avoid_elements: ['夸张标题'],
  creator_declaration: {
    creator_goal: '分享认知',
    avoid_preference: '空洞鸡汤',
    quality_standard: '让人思考',
    interviewedAt: '2026-08-01T00:00:00.000Z',
    source: 'settings',
  },
  editing_profile: {
    preferences: [
      { type: 'like', statement: '开头冲突', confidence: 0.7, sourceCount: 2, examples: [] },
      { type: 'avoid', statement: '堆砌形容词', confidence: 0.6, sourceCount: 3, examples: [] },
    ],
    samples: 5,
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
  interest_profile: {
    topic_interest: [{ name: 'AI 教育', weight: 80, reason: '创作 6 篇' }],
    core: [{ label: 'AI 教育' }],
    domains: { 'AI 教育': 0.6 },
    identity: { completeness: 0.5 },
  },
  style_dimensions: { dims: { opening: 0.8 }, samples: 6 },
}

describe('buildCreatorContextBlocks 空值与降级', () => {
  it('profile 为 null / 非对象：全部返回空，零字数开销', () => {
    for (const input of [null, undefined, 'broken'] as unknown[]) {
      const blocks = buildCreatorContextBlocks(input as CreatorContextProfile | null, {
        stage: 'plan',
      })
      expect(blocks.styleText).toBe('')
      expect(blocks.creatorText).toBe('')
      expect(blocks.interestText).toBe('')
      expect(blocks.avoid).toEqual([])
      expect(blocks.layers).toEqual([])
    }
  })

  it('未建模用户（只有风格统计）不注入人格/声明/偏好', () => {
    const blocks = buildCreatorContextBlocks(
      { tone_tags: ['平实'], avg_length: 800 },
      { stage: 'article' }
    )
    expect(blocks.styleText).toContain('平实')
    expect(blocks.creatorText).toBe('')
    expect(blocks.layers).toEqual([])
  })
})

describe('buildCreatorContextBlocks 块集合（防漂移核心）', () => {
  it('三个阶段注入同一套块：人格 / 声明 / 修改偏好 / 兴趣 —— 缺一即漂移', () => {
    for (const stage of ['plan', 'blueprint', 'article'] as const) {
      const blocks = buildCreatorContextBlocks(PROFILE, { stage })
      expect(blocks.layers, `阶段 ${stage} 缺块`).toContain('创作者声明')
      expect(blocks.layers, `阶段 ${stage} 缺块`).toContain('修改偏好记忆')
      expect(blocks.layers, `阶段 ${stage} 缺块`).toContain('长期关注领域')
      expect(blocks.creatorText).toContain('空洞鸡汤')
      expect(blocks.creatorText).toContain('堆砌形容词')
    }
  })

  it('声明优先于人格：声明块排在人格块之后但在修改偏好之前', () => {
    const blocks = buildCreatorContextBlocks(PROFILE, { stage: 'plan' })
    const iPersonality = blocks.creatorText.indexOf('创作者人格')
    const iDeclaration = blocks.creatorText.indexOf('创作者主动声明')
    const iEditing = blocks.creatorText.indexOf('修改偏好')
    expect(iPersonality).toBeGreaterThanOrEqual(0)
    expect(iDeclaration).toBeGreaterThan(iPersonality)
    expect(iEditing).toBeGreaterThan(iDeclaration)
  })

  it('阶段只改指令措辞，不改块内容', () => {
    const plan = buildCreatorContextBlocks(PROFILE, { stage: 'plan' })
    const blueprint = buildCreatorContextBlocks(PROFILE, { stage: 'blueprint' })
    const article = buildCreatorContextBlocks(PROFILE, { stage: 'article' })
    // "三个方向"是方案阶段风格块的指令句（方案产出三方向，蓝图没有这个概念）
    expect(plan.styleText).toContain('三个方向')
    expect(blueprint.creatorText).toContain('蓝图')
    expect(article.creatorText).not.toContain('三个方向')
    // 指令句之外的主体必须完全一致
    const strip = (t: string) => t.split('\n\n').filter((p) => !p.startsWith('请在')).join('\n\n')
    expect(strip(plan.creatorText)).toBe(strip(blueprint.creatorText))
  })
})

describe('buildCreatorContextBlocks 硬禁忌与证据', () => {
  it('三路硬禁忌合并去重：人格排斥 + 声明排斥 + 高置信拒绝过的改法', () => {
    const blocks = buildCreatorContextBlocks(PROFILE, { stage: 'article' })
    expect(blocks.avoid).toContain('夸张标题')
    expect(blocks.avoid).toContain('空洞鸡汤')
    expect(blocks.avoid).toContain('堆砌形容词')
    expect(new Set(blocks.avoid).size).toBe(blocks.avoid.length)
  })

  it('低置信（sourceCount<2）的拒绝不进硬禁忌，避免单次行为定性用户', () => {
    const blocks = buildCreatorContextBlocks(
      {
        ...PROFILE,
        editing_profile: {
          preferences: [
            { type: 'avoid', statement: '偶尔不喜欢的写法', confidence: 0.4, sourceCount: 1, examples: [] },
          ],
          samples: 1,
        },
      },
      { stage: 'article' }
    )
    expect(blocks.avoid).not.toContain('偶尔不喜欢的写法')
  })

  it('回传声明维度，供前端展示"本次参考了什么"', () => {
    const blocks = buildCreatorContextBlocks(PROFILE, { stage: 'article' })
    expect(blocks.declarationTraits.map((t) => t.dimension)).toContain('排斥内容')
    expect(blocks.declarationTraits.find((t) => t.dimension === '排斥内容')?.hard).toBe(true)
  })

  it('includeEditing=false 时可单独关闭修改偏好（仅供排障用）', () => {
    const blocks = buildCreatorContextBlocks(PROFILE, {
      stage: 'article',
      includeEditing: false,
    })
    expect(blocks.layers).not.toContain('修改偏好记忆')
    expect(blocks.creatorText).not.toContain('堆砌形容词')
  })
})

describe('buildCreatorContextBlocks 预算守卫', () => {
  it('超长块被截断且显式标注，而不是静默丢弃整块', () => {
    const longAvoid = Array.from({ length: 800 }, (_, i) => `禁忌${i}`).join('、')
    const blocks = buildCreatorContextBlocks(
      { avoid_elements: [longAvoid] },
      { stage: 'article' }
    )
    expect(blocks.creatorText.length).toBeLessThanOrEqual(2800)
    expect(blocks.creatorText).toContain('已截断')
    expect(blocks.avoid[0].length).toBeGreaterThan(0)
  })

  it('兴趣块预算可被阶段收紧（方案阶段上下文更紧张）', () => {
    // 8 条主题：足以撑满 600 字预算，才能看出 maxLength 的差异
    const manyTopics = {
      ...PROFILE,
      interest_profile: {
        topic_interest: Array.from({ length: 8 }, (_, i) => ({
          name: `长期关注领域${i}`,
          weight: 90 - i,
          reason: `创作 ${10 - i} 篇相关作品`,
        })),
        domains: {},
        identity: { completeness: 0.8 },
      },
    }
    const tight = buildCreatorContextBlocks(manyTopics, {
      stage: 'plan',
      interest: { maxTopics: 1, maxLength: 120 },
    })
    const loose = buildCreatorContextBlocks(manyTopics, {
      stage: 'article',
      interest: { maxTopics: 6, maxLength: 600 },
    })
    expect(tight.interestText.length).toBeLessThan(loose.interestText.length)
  })
})
