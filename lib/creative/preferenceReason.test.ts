import { describe, expect, it } from 'vitest'
import { extractPreferenceReasons } from './preferenceReason'
import { applyMemoryEvent, parseEditingProfile } from './editingMemory'

describe('extractPreferenceReasons', () => {
  it('「不要太像新闻」→ 避开新闻口径，并推出正向偏好：个人观点表达', () => {
    const r = extractPreferenceReasons('这篇不要太像新闻')
    expect(r.length).toBe(1)
    expect(r[0].kind).toBe('avoid')
    expect(r[0].statement).toBe('新闻通稿式的客观报道口径')
    expect(r[0].alternative).toBe('带个人观点的表达')
  })

  it('「太复杂了」→ 大众理解优先', () => {
    const r = extractPreferenceReasons('太复杂了，看不懂')
    expect(r[0].kind).toBe('avoid')
    expect(r[0].statement).toBe('难懂的复杂表达')
    expect(r[0].alternative).toBe('大众能一次读懂的说法')
  })

  it('「太像 AI 写的」→ 避开通用 AI 腔调', () => {
    const r = extractPreferenceReasons('感觉太像AI写的')
    expect(r[0].statement).toBe('通用 AI 腔调')
  })

  it('正向诉求「更有观点一点」→ like，而不是 avoid', () => {
    const r = extractPreferenceReasons('希望更有观点一点')
    expect(r.some((x) => x.kind === 'like' && x.statement === '鲜明的个人观点')).toBe(true)
  })

  it('「加个案例」→ like 具体真实案例', () => {
    const r = extractPreferenceReasons('加个具体案例')
    expect(r.some((x) => x.kind === 'like' && x.statement === '具体的真实案例')).toBe(true)
  })

  it('抽不出稳定语义时返回空——宁可不记，也不把噪声写进长期记忆', () => {
    expect(extractPreferenceReasons('开头改一下')).toEqual([])
    expect(extractPreferenceReasons('嗯')).toEqual([])
  })

  it('同一陈述不重复记录', () => {
    const r = extractPreferenceReasons('不要太长也不要太长')
    const keys = r.map((x) => `${x.kind}:${x.statement}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('applyMemoryEvent 接入修改原因', () => {
  it('接受修改时，avoid 与其正向偏好同时入库', () => {
    const prev = parseEditingProfile(null)
    const next = applyMemoryEvent(prev, {
      accepted: true,
      freeText: '这篇不要太像新闻',
      reasons: extractPreferenceReasons('这篇不要太像新闻'),
    })
    const stmts = next.preferences.map((p) => `${p.type}:${p.statement}`)
    expect(stmts).toContain('avoid:新闻通稿式的客观报道口径')
    expect(stmts).toContain('like:带个人观点的表达')
  })

  it('拒绝修改时不写偏好——拒绝只说明这轮改得不好，不代表他不想要', () => {
    const prev = parseEditingProfile(null)
    const next = applyMemoryEvent(prev, {
      accepted: false,
      freeText: '这篇不要太像新闻',
      reasons: extractPreferenceReasons('这篇不要太像新闻'),
    })
    expect(next.preferences).toEqual([])
    expect(next.samples).toBe(1)
  })
})
