import { describe, expect, it } from 'vitest'
import { extractEditDiffSignals } from './editDiff'

/**
 * 长尾正文：必须超过 MIN_ORIGINAL_LEN（80 字）才能进入差异比较，
 * 且刻意不含任何套路词 / emoji / 互动结尾，保证各用例只触发目标信号。
 */
const TAIL =
  '这是一个值得长期关注的现象，需要持续投入精力去跟踪变化，并且在实践中不断修正自己的判断，才能形成稳定的认知框架，进而把零散的观察沉淀成可复用的方法论，也才能让每一次创作都站在上一次的积累之上。这一点在长期内容创作中尤为重要。'

const keys = (r: ReturnType<typeof extractEditDiffSignals>) =>
  r.map((x) => `${x.kind}:${x.statement}`)

describe('extractEditDiffSignals', () => {
  it('删掉套路连接词 → 记为 avoid，并给出正向替代写法', () => {
    const original = `首先，我们要理解这件事的背景。其次，需要看清其中的关键变量。再者，还要考虑外部环境的影响。综上所述，${TAIL}`
    const edited = `我们要理解这件事的背景，也要看清其中的关键变量，还要考虑外部环境的影响。${TAIL}`
    const r = extractEditDiffSignals(original, edited)
    const k = keys(r)
    expect(k).toContain('avoid:套路化顺序连接词（首先/其次）')
    expect(k).toContain('avoid:套路化总结词（综上所述）')
    // avoid 必须带 alternative，否则 AI 只知道不该做什么、不知道该往哪走
    expect(r.find((x) => x.statement.includes('顺序连接词'))?.alternative).toBeTruthy()
  })

  it('原稿太短（标题级）不产出信号——结构信号不可靠', () => {
    expect(extractEditDiffSignals('短视频开头三秒法则', '开头三秒定律')).toEqual([])
  })

  it('内容没变（只改了空白）不产出信号', () => {
    const t = `${TAIL}${TAIL}`
    expect(extractEditDiffSignals(t, `  ${t}\n`)).toEqual([])
  })

  it('原稿为空不产出信号', () => {
    expect(extractEditDiffSignals('', TAIL)).toEqual([])
  })

  it('篇幅显著删减 → like「更精简的表达」', () => {
    const unit = '这是一段用于测试篇幅变化的正文内容，'
    const r = extractEditDiffSignals(unit.repeat(10), unit.repeat(5))
    expect(keys(r)).toContain('like:更精简的表达')
  })

  it('小幅删改（不足阈值）不记为篇幅偏好，避免噪声', () => {
    const unit = '这是一段用于测试篇幅变化的正文内容，'
    const r = extractEditDiffSignals(unit.repeat(10), unit.repeat(10).slice(0, -6))
    expect(keys(r)).not.toContain('like:更精简的表达')
  })

  it('emoji 被清空 → avoid「emoji 装饰」', () => {
    const r = extractEditDiffSignals(`${TAIL}🎉🚀✨`, TAIL)
    expect(keys(r)).toContain('avoid:emoji 装饰')
  })

  it('删掉结尾硬性互动 → avoid「结尾硬性互动提问」', () => {
    const r = extractEditDiffSignals(`${TAIL}你觉得呢？`, TAIL)
    expect(keys(r)).toContain('avoid:结尾硬性互动提问')
  })

  it('段落被拆得更碎 → like「更短的段落节奏」', () => {
    const para = (n: number) => `这是第${n}段正文内容，用于测试段落拆分信号的识别效果。`
    const original = [para(1), para(2), para(3)].join('\n\n')
    const edited = [para(1), para(2), para(3), para(4), para(5), para(6)].join('\n\n')
    const r = extractEditDiffSignals(original, edited)
    expect(keys(r)).toContain('like:更短的段落节奏')
  })

  it('同一陈述只留一条（多规则命中同一 statement 时去重）', () => {
    const original = `首先，${TAIL}其次，${TAIL}再者，${TAIL}`
    const edited = TAIL.repeat(3)
    const r = extractEditDiffSignals(original, edited)
    const dedup = r.filter((x) => x.statement.includes('顺序连接词'))
    expect(dedup.length).toBe(1)
  })
})
