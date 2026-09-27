import { describe, expect, it } from 'vitest'
import { checkConsistency } from './consistencyCheck'

const TEXT =
  '我一直认为 AI 教育的重点不是工具，而是认知脚手架。这一点在数学课堂上尤其明显。'

describe('checkConsistency 无数据一律 unknown（不许糊过去）', () => {
  it('空输入：三问全 unknown，hasAnySignal=false', () => {
    const c = checkConsistency({ text: TEXT })
    expect(c.knowledge.verdict).toBe('unknown')
    expect(c.interest.verdict).toBe('unknown')
    expect(c.viewpoint.verdict).toBe('unknown')
    expect(c.hasAnySignal).toBe(false)
  })

  it('有知识但为空数组 → 仍是 unknown（空数组不等于"知识范围是空的"）', () => {
    const c = checkConsistency({ text: TEXT, knowledge: [] })
    expect(c.knowledge.verdict).toBe('unknown')
  })
})

describe('checkConsistency 知识一致性', () => {
  it('正文出现已确认概念 → aligned 并列出命中的概念', () => {
    const c = checkConsistency({
      text: TEXT,
      knowledge: [{ concept: '认知脚手架' }, { concept: '无关概念' }],
    })
    expect(c.knowledge.verdict).toBe('aligned')
    expect(c.knowledge.hits).toEqual(['认知脚手架'])
  })

  it('正文没用上但主题在适用范围内 → partial（"没用上"不等于"不相关"）', () => {
    const c = checkConsistency({
      text: '一篇完全不相干的正文。',
      topic: 'AI 教育',
      knowledge: [{ concept: '认知脚手架', domainScope: ['AI 教育'] }],
    })
    expect(c.knowledge.verdict).toBe('partial')
  })

  it('正文与主题都不在知识范围 → off', () => {
    const c = checkConsistency({
      text: '一篇完全不相干的正文。',
      topic: '做菜技巧',
      knowledge: [{ concept: '认知脚手架', domainScope: ['AI 教育'] }],
    })
    expect(c.knowledge.verdict).toBe('off')
  })

  it('标点 / 空白差异不影响命中（"真实案例，"应匹配"真实案例"）', () => {
    const c = checkConsistency({
      text: '这里讲的是真实案例，不是虚构。',
      knowledge: [{ concept: '真实案例' }],
    })
    expect(c.knowledge.verdict).toBe('aligned')
  })
})

describe('checkConsistency 兴趣一致性', () => {
  it('正文命中关注领域 → aligned', () => {
    const c = checkConsistency({
      text: TEXT,
      interestTopics: ['AI 教育', '摄影'],
    })
    expect(c.interest.verdict).toBe('aligned')
    expect(c.interest.hits).toContain('AI 教育')
  })

  it('只有主题命中、正文未展开 → partial', () => {
    const c = checkConsistency({
      text: '一篇没有展开该领域的正文。',
      topic: 'AI 教育',
      interestTopics: ['AI 教育'],
    })
    expect(c.interest.verdict).toBe('partial')
  })

  it('毫不相关 → off（新探索不算问题，但要有诚实说明）', () => {
    const c = checkConsistency({
      text: '一篇讲摄影的正文。',
      topic: '摄影',
      interestTopics: ['AI 教育'],
    })
    expect(c.interest.verdict).toBe('off')
  })
})

describe('checkConsistency 观点一致性（只判踩雷，不判立场）', () => {
  it('踩到硬禁忌 → off', () => {
    const c = checkConsistency({
      text: '这段是彻头彻尾的空洞鸡汤。',
      hardAvoids: ['空洞鸡汤'],
    })
    expect(c.viewpoint.verdict).toBe('off')
    expect(c.viewpoint.hits).toEqual(['空洞鸡汤'])
  })

  it('没踩雷也只给 unknown —— 立场是否一致需要语义判断，绝不假装判过', () => {
    const c = checkConsistency({
      text: TEXT,
      hardAvoids: ['空洞鸡汤'],
    })
    expect(c.viewpoint.verdict).toBe('unknown')
    expect(c.viewpoint.detail).toContain('不做猜测')
  })
})

describe('checkConsistency 综合', () => {
  it('任一路可判定即展示该区块', () => {
    const c = checkConsistency({
      text: TEXT,
      knowledge: [{ concept: '认知脚手架' }],
    })
    expect(c.hasAnySignal).toBe(true)
  })

  it('没踩雷不构成"观点一致"的信号 —— 只有 unknown 与 off 两种结论', () => {
    const c = checkConsistency({ text: TEXT, hardAvoids: ['空洞鸡汤'] })
    // 用户没排除内容被踩到，只是"没有冲突"，不等于"立场一致"
    expect(c.viewpoint.verdict).toBe('unknown')
    expect(c.hasAnySignal).toBe(false)
  })
})
