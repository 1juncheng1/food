// ============================================================
// WF4：四维标签 TagVector（内容/思想/情绪/创作方式）
//
// 拒绝单一分类标签：每簇抽四维 ≤5 标签 + tag_embedding（bge-m3，
// builder 侧计算）。红线：
//   1. LLM 失败/畸形输出 → 空 TagDims（永不抛错、不阻塞 build）
//   2. 标签写入只来自 DeepSeek 结构化输出，evidence 红线不适用于
//      标签本身（标签是画像维度，不进推荐理由）
//   3. tagOverlapFor：无标签/无向量 → 兜底 1（不打压存量候选）
// ============================================================

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { batchExtractTagDims, tagDimsToText, tagOverlapFor, emptyTagDims, pickEmbeddingBackfill, backfillEmbeddings, type TagDims } from './tagVector'

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  // vitest 不加载 .env.local：前两个用例需要 key 走 LLM 路径
  process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? 'test-key'
})

function llmResponse(tags: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(tags) } }] }),
  }
}

describe('batchExtractTagDims：四维标签抽取', () => {
  it('LLM 正常输出 → 按 tempId 返回四维标签，每维 ≤5', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(llmResponse({
      'new-0': {
        content: ['AI创业', '商业趋势', '深度分析', '职业选择', '技术伦理', '多余项'],
        thought: ['观点拆解'],
        emotion: ['理性'],
        craft: ['案例支撑'],
      },
    })))

    const out = await batchExtractTagDims([
      { tempId: 'new-0', label: 'AI创业', summary: 'AI 相关创作', keywords: ['AI'], topics: ['AI 是否取代普通人'] },
    ])
    const t = out.get('new-0')!
    expect(t.content).toEqual(['AI创业', '商业趋势', '深度分析', '职业选择', '技术伦理']) // 第 6 项截断
    expect(t.thought).toEqual(['观点拆解'])
    expect(t.emotion).toEqual(['理性'])
    expect(t.craft).toEqual(['案例支撑'])
  })

  it('四维键缺失/非数组 → 该维空数组（容忍畸形）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(llmResponse({
      'new-0': { content: '不是数组', emotion: [123, '理性', null] },
    })))
    const t = (await batchExtractTagDims([{ tempId: 'new-0', label: 'x', summary: '', keywords: [], topics: [] }])).get('new-0')!
    expect(t.content).toEqual([])
    expect(t.thought).toEqual([])
    expect(t.emotion).toEqual(['理性']) // 非字符串剔除
    expect(t.craft).toEqual([])
  })

  it('网络失败 → 每簇空 TagDims，永不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const out = await batchExtractTagDims([
      { tempId: 'a', label: 'x', summary: '', keywords: [], topics: [] },
      { tempId: 'b', label: 'y', summary: '', keywords: [], topics: [] },
    ])
    expect(out.get('a')).toEqual(emptyTagDims())
    expect(out.get('b')).toEqual(emptyTagDims())
  })

  it('无 DEEPSEEK_API_KEY → 空结果直接返回（不触网）', async () => {
    const prev = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const out = await batchExtractTagDims([{ tempId: 'a', label: 'x', summary: '', keywords: [], topics: [] }])
    expect(out.get('a')).toEqual(emptyTagDims())
    expect(fetchSpy).not.toHaveBeenCalled()
    if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev
  })
})

describe('pickEmbeddingBackfill（WF9 修复：补算优先最新事件）', () => {
  const emb = () => Array.from({ length: 1024 }, () => 0.1)
  // events 数组为正序（最老在前，fetchEvents 已 reverse）
  function fakeEvent(id: string, withEmb: boolean) {
    return { id, embedding: withEmb ? emb() : null, type: 'work_generate' }
  }

  it('缺向量事件按"最新优先"挑选，上限 50（旧实现 slice(0,50) 永远补最老的，新事件永远进不了画像）', () => {
    const events: Array<{ id: string; embedding: number[] | null; type: string }> = [
      ...Array.from({ length: 55 }, (_, i) => fakeEvent(`old-${i}`, false)), // 最老 55 条缺向量
      fakeEvent('mid', true),
      ...Array.from({ length: 5 }, (_, i) => fakeEvent(`new-${i}`, false)), // 最新 5 条
    ]
    const picked = pickEmbeddingBackfill(events, 50)
    expect(picked).toHaveLength(50)
    // 必须包含最新的 5 条
    for (let i = 0; i < 5; i++) expect(picked.map((e) => e.id)).toContain(`new-${i}`)
    // 不应包含最老的 5 条（它们被更新事件挤出配额）
    for (let i = 0; i < 5; i++) expect(picked.map((e) => e.id)).not.toContain(`old-${i}`)
  })

  it('有向量的事件不参与补算；缺向量不足上限时全选', () => {
    const events: Array<{ id: string; embedding: number[] | null; type: string }> = [
      fakeEvent('a', true),
      fakeEvent('b', false),
      fakeEvent('c', false),
    ]
    const picked = pickEmbeddingBackfill(events, 50)
    expect(picked.map((e) => e.id)).toEqual(['b', 'c'])
  })
})

describe('backfillEmbeddings（并发补算池，build 耗时治理）', () => {
  type Ev = { id: string; _topic?: string; embedding?: number[] | null }
  const emb = () => [0.1, 0.2]

  it('有 _topic 的事件全部补算并就地写回；无 _topic 的跳过', async () => {
    const events: Ev[] = [
      { id: 'a', _topic: '选题甲', embedding: null },
      { id: 'b', embedding: null },
      { id: 'c', _topic: '选题丙', embedding: null },
    ]
    const out = await backfillEmbeddings(events, async () => emb(), 6)
    expect(out.map((x) => x.id).sort()).toEqual(['a', 'c'])
    expect(events[0].embedding).toEqual(emb())
    expect(events[1].embedding).toBeNull()
  })

  it('单个 embedFn 抛错或返回 null → 跳过该项不抛异常，其余照常补算', async () => {
    const events: Ev[] = [
      { id: 'ok1', _topic: 't1', embedding: null },
      { id: 'boom', _topic: 't2', embedding: null },
      { id: 'nullret', _topic: 't3', embedding: null },
      { id: 'ok2', _topic: 't4', embedding: null },
    ]
    const embedFn = vi.fn(async (text: string) => {
      if (text === 't2') throw new Error('rate limit')
      if (text === 't3') return null
      return emb()
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await backfillEmbeddings(events, embedFn, 6)
    expect(out.map((x) => x.id).sort()).toEqual(['ok1', 'ok2'])
    spy.mockRestore()
  })

  it('并发度受控：13 个任务 concurrency=4 时在途峰值恰为 4，且完成一个立即补位（非分批 Promise.all）', async () => {
    const events: Ev[] = Array.from({ length: 13 }, (_, i) => ({ id: `e${i}`, _topic: `t${i}`, embedding: null }))
    let inFlight = 0
    let peak = 0
    const embedFn = vi.fn(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight -= 1
      return emb()
    })
    const t0 = Date.now()
    const out = await backfillEmbeddings(events, embedFn, 4)
    const elapsed = Date.now() - t0
    expect(out).toHaveLength(13)
    expect(peak).toBe(4)
    // 串行需 130ms+；4 并发理论 ~40ms，给宽限
    expect(elapsed).toBeLessThan(100)
  })
})

describe('tagDimsToText / tagOverlapFor', () => {
  it('tagDimsToText 拼接全部四维标签', () => {
    const text = tagDimsToText({
      content: ['AI创业'],
      thought: ['观点拆解'],
      emotion: ['理性'],
      craft: ['案例支撑'],
    })
    expect(text).toBe('AI创业 观点拆解 理性 案例支撑')
  })

  it('tagOverlapFor：无标签向量或无候选向量 → 兜底 1（不打压）', () => {
    expect(tagOverlapFor([0.1, 0.2], null)).toBe(1)
    expect(tagOverlapFor(null, [0.1, 0.2])).toBe(1)
    expect(tagOverlapFor(null, null)).toBe(1)
    // 维度不匹配也兜底
    expect(tagOverlapFor([0.1, 0.2], [0.1, 0.2, 0.3])).toBe(1)
  })

  it('tagOverlapFor：双 1024 向量 → 余弦值 clamp 到 [0,1]', () => {
    const a = Array.from({ length: 1024 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5))
    const b = Array.from({ length: 1024 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5)) // 同向
    const c = Array.from({ length: 1024 }, (_, i) => (i % 2 === 0 ? -0.5 : 0.5)) // 反向
    expect(tagOverlapFor(a, b)).toBeCloseTo(1, 5)
    expect(tagOverlapFor(a, c)).toBe(0) // 负相关 clamp 到 0
  })
})
