// ============================================================
// candidates.test.ts —— 候选向量化（embedCandidates）
//
// 这条链路的存在理由：S4（LLM 生成）与 S6（知识单元）产出的候选
// embedding 恒为 null，而队列里绝大多数卡来自 S4。补不上向量，
// hardFilter 三重查重、候选→簇匹配、语义评分三个子项会同时失效。
// 下面的用例锁住的是"补得上、补得对、补失败也不拖垮 build"。
// ============================================================

import { describe, expect, it, vi } from 'vitest'
import { candidateEmbedText, embedCandidates, hardFilter, type Candidate } from './candidates'

const DIM = 1024
const vec = (fill = 0.01) => new Array(DIM).fill(fill)

function cand(over: Partial<Candidate> = {}): Candidate {
  return {
    source: 'exploration',
    slot: 'exploration',
    title: '低学历创业者的 AI 替代焦虑',
    description: '你分析过这个主题，价值分 8/10',
    topic: 'AI 替代与创业',
    formHint: '其他',
    embedding: null,
    clusterCode: null,
    contentValue: 0.8,
    marketRefs: null,
    ...over,
  }
}

describe('candidateEmbedText', () => {
  it('只拼 title + topic，不含 description（元信息会稀释方向信号）', () => {
    const t = candidateEmbedText(cand())
    expect(t).toContain('低学历创业者的 AI 替代焦虑')
    expect(t).toContain('AI 替代与创业')
    expect(t).not.toContain('价值分')
  })

  it('缺 topic 时退化成只有 title；两者皆空返回空串', () => {
    expect(candidateEmbedText(cand({ topic: '' }))).toBe('低学历创业者的 AI 替代焦虑')
    expect(candidateEmbedText(cand({ title: '', topic: '' }))).toBe('')
  })
})

describe('embedCandidates', () => {
  it('给无向量的候选补上 1024 维向量，并返回补上的条数', async () => {
    const a = cand()
    const b = cand()
    const n = await embedCandidates([a, b], async () => vec())
    expect(n).toBe(2)
    expect(a.embedding).toHaveLength(DIM)
    expect(b.embedding).toHaveLength(DIM)
  })

  it('已是 1024 维的候选不再重复调 API（成本闸门）', async () => {
    const existing = vec(0.5)
    const a = cand({ embedding: existing })
    const embedFn = vi.fn(async () => vec())
    const n = await embedCandidates([a], embedFn)
    expect(n).toBe(0)
    expect(embedFn).not.toHaveBeenCalled()
    expect(a.embedding).toBe(existing) // 同一引用，未被覆盖
  })

  it('维度不对的候选会被重算（不是 1024 维视为无效）', async () => {
    const a = cand({ embedding: [1, 2, 3] })
    const n = await embedCandidates([a], async () => vec())
    expect(n).toBe(1)
    expect(a.embedding).toHaveLength(DIM)
  })

  it('就地修改同一对象——builder 的 forceBind 是 WeakMap，换对象会查不到', async () => {
    const a = cand()
    const ref = a
    await embedCandidates([a], async () => vec())
    expect(ref.embedding).toHaveLength(DIM)
  })

  it('embedFn 抛错 / 返回 null → 该条保持原状，其余照常，不抛异常', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = cand({ title: 'ok' })
    const boom = cand({ title: 'boom' })
    const nullish = cand({ title: 'nullish' })
    const titles: string[] = []
    const n = await embedCandidates([ok, boom, nullish], async (t) => {
      titles.push(t)
      if (t.startsWith('boom')) throw new Error('rate limit')
      if (t.startsWith('nullish')) return null
      return vec()
    })
    expect(n).toBe(1)
    expect(ok.embedding).toHaveLength(DIM)
    expect(boom.embedding).toBeNull()
    expect(nullish.embedding).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('空文本候选直接跳过，不浪费一次 API', async () => {
    const embedFn = vi.fn(async () => vec())
    const a = cand({ title: '', topic: '' })
    const n = await embedCandidates([a], embedFn)
    expect(n).toBe(0)
    expect(embedFn).not.toHaveBeenCalled()
  })

  it('并发受控：并发上限 2 时同飞请求不超过 2', async () => {
    let inFlight = 0
    let peak = 0
    const many = Array.from({ length: 9 }, (_, i) => cand({ title: `t${i}` }))
    await embedCandidates(many, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return vec()
    }, 2)
    expect(peak).toBeLessThanOrEqual(2)
    expect(many.every((c) => c.embedding?.length === DIM)).toBe(true)
  })

  it('返回非 1024 维的脏向量不写入（不能让下游拿到残废向量）', async () => {
    const a = cand()
    const n = await embedCandidates([a], async () => [1, 2, 3])
    expect(n).toBe(0)
    expect(a.embedding).toBeNull()
  })
})

describe('hardFilter：向量补全后才真正生效', () => {
  const unit = (i: number) => {
    const v = new Array(DIM).fill(0)
    v[i] = 1
    return v
  }

  it('无向量的候选一律放行 —— 这正是修复前查重静默失效的原因', () => {
    const c = cand({ embedding: null })
    expect(hardFilter([c], [unit(0)], [unit(1)], [])).toHaveLength(1)
  })

  it('有向量后：与"已写过"高度相似的候选被过滤', () => {
    const dup = cand({ embedding: unit(0) })
    const fresh = cand({ embedding: unit(5) })
    const out = hardFilter([dup, fresh], [unit(0)], [], [])
    expect(out.map((c) => c.embedding?.[5])).toEqual([1])
  })

  it('有向量后：与"已 ✕"相似的候选被过滤（口味反馈真正生效）', () => {
    const disliked = cand({ embedding: unit(2) })
    const fresh = cand({ embedding: unit(7) })
    const out = hardFilter([disliked, fresh], [], [unit(2)], [])
    expect(out.map((c) => c.embedding?.[7])).toEqual([1])
  })
})
