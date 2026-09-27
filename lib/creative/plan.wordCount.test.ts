import { describe, expect, it } from 'vitest'
import { normalizePlan } from './plan'

/** 最小合法方案：directions 至少一项且 title/viewpoint 非空 */
function rawPlan(wordOptions: number[], recommended: number) {
  return {
    content_type: '观点短文',
    content_type_reason: '适合表达观点',
    target_audience: '内容创作者',
    directions: [
      {
        key: 'A',
        title: '观察角度',
        desc: '从真实体验切入',
        viewpoint: '从创作者体验分析',
        structure: ['提出问题', '展开分析'],
        emotion_curve: '平静到明确',
        opening_hook: '从一个问题开始',
        core_conflict: '表达与理解的差异',
        ending: '回到创作本身',
        strategy: '以具体经验支撑观点',
        language_style: { pace: '舒缓', mood: '克制', expression: '分析' },
      },
    ],
    recommended_direction_key: 'A',
    word_count_options: wordOptions,
    recommended_word_count: recommended,
    personal_reason: '',
  }
}

describe('normalizePlan 自定义目标字数', () => {
  it('指定了字数：推荐档必须等于该字数，且三档中必须包含它', () => {
    const plan = normalizePlan(rawPlan([800, 1200, 2000], 1200), 1500)
    expect(plan).not.toBeNull()
    expect(plan?.recommended_word_count).toBe(1500)
    expect(plan?.word_count_options).toContain(1500)
    expect(plan?.word_count_options).toHaveLength(3)
  })

  it('AI 未按指令给档时同样被纠正（三档照旧也不丢用户字数）', () => {
    const plan = normalizePlan(rawPlan([600, 900, 1200], 900), 3000)
    expect(plan?.recommended_word_count).toBe(3000)
    expect(plan?.word_count_options).toContain(3000)
  })

  it('未指定字数时完全沿用 AI 给档，行为与改动前一致', () => {
    const plan = normalizePlan(rawPlan([800, 1200, 2000], 1200), null)
    expect(plan?.recommended_word_count).toBe(1200)
    expect(plan?.word_count_options).toEqual([800, 1200, 2000])
  })

  it('越界字数（<100 / >5000）一律忽略，不会写进方案', () => {
    expect(normalizePlan(rawPlan([800, 1200, 2000], 1200), 20)?.recommended_word_count).toBe(1200)
    expect(normalizePlan(rawPlan([800, 1200, 2000], 1200), 99999)?.recommended_word_count).toBe(1200)
  })
})
