// ============================================================
// retrieveMaterials —— Material Library 2.0 Phase 3 核心机制单测
//
// 覆盖：
//   AC-2 纯主题向量（RPC 入参与 topicEmbedding 逐维相同，无 mix，无标签硬过滤参数）
//   AC-3 0.55 硬阈值（0.54 排除 / 0.55、0.56 保留）
//   AC-4 标签不能单独决定召回（0.8 不匹配仍召回 / 0.4 全匹配仍排除）
//   AC-5 selected 置顶/score=1/去重/截断/missingSelectedIds
//   AC-6 embedding 失败降级不抛错；LLM 理由坏 JSON 回退模板
//   另有带状比较器对拍 + 自动召回条数上限
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/storage', () => ({
  generateEmbedding: vi.fn(),
}))

import { generateEmbedding } from '@/lib/storage'
import {
  retrieveMaterials,
  compareCandidates,
  normalizeSelectedIds,
  MAX_SELECTED,
  type CandidateLike,
  type SoftSignalContext,
} from './retrieval'

const mockedEmbed = vi.mocked(generateEmbedding)

// ── fixtures ─────────────────────────────────────────────

interface MockRow {
  id: string
  content: string | null
  type: string | null
  material_type: string | null
  ai_summary: string | null
  related_topics: string[] | null
  knowledge: unknown
}

function row(id: string, over: Partial<MockRow> = {}): MockRow {
  return {
    id,
    content: `素材正文-${id}`,
    type: 'text',
    material_type: null,
    ai_summary: null,
    related_topics: null,
    knowledge: null,
    ...over,
  }
}

function rpcRows(sims: Array<[string, number]>) {
  return sims.map(([id, similarity]) => ({ id, content: `rpc正文-${id}`, similarity }))
}

interface MakeClientOpts {
  rpc?: Array<{ id: string; similarity: number }>
  rpcError?: unknown
  rows?: Record<string, MockRow>
}

function makeClient(opts: MakeClientOpts = {}) {
  const rpcCalls: Array<Record<string, unknown>> = []
  const inCalls: string[][] = []
  const rows = opts.rows ?? {}

  const rpcMock = vi.fn(async (_fn: string, params: Record<string, unknown>) => {
    rpcCalls.push(params)
    if (opts.rpcError) return { data: null, error: opts.rpcError }
    return { data: opts.rpc ?? [], error: null }
  })

  const inMock = vi.fn(async (_col: string, ids: string[]) => {
    inCalls.push(ids)
    return { data: ids.map((id) => rows[id]).filter(Boolean), error: null }
  })

  // from('scripts').select(COLUMNS).in('id', ids) 链式 mock
  const builder: Record<string, unknown> = {}
  builder.select = vi.fn(() => builder)
  builder.in = inMock

  const client = {
    rpc: rpcMock,
    from: vi.fn(() => builder),
  }
  return {
    client: client as unknown as SupabaseClient,
    rpcCalls,
    inCalls,
  }
}

const TOPIC_EMBEDDING = Array.from({ length: 1024 }, (_, i) => (i + 1) / 1024)
const INPUT = { userId: 'user-1', currentTopic: '创业公司如何找到增长方向' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  // lib/llm.ts 在缺少 DEEPSEEK_API_KEY 时会直接返回 missing_api_key 而不发起 fetch，
  // LLM 相关用例按需 stubEnv；这里保证用例之间不串味
  vi.unstubAllEnvs()
  mockedEmbed.mockReset()
  mockedEmbed.mockResolvedValue([0.01, 0.02, 0.03])
})

// ── AC-2 纯主题向量 ───────────────────────────────────────

describe('AC-2：召回使用纯主题向量，全链路无混入', () => {
  it('RPC query_embedding 与传入 topicEmbedding 引用相同、逐维严格相等', async () => {
    const { client, rpcCalls } = makeClient({ rpc: [] })

    await retrieveMaterials(client, INPUT, { topicEmbedding: TOPIC_EMBEDDING })

    expect(rpcCalls).toHaveLength(1)
    const params = rpcCalls[0]
    // 引用相同（中间没有任何 mixVectors 重建）
    expect(params.query_embedding).toBe(TOPIC_EMBEDDING)
    // 逐维严格相等
    const vec = params.query_embedding as number[]
    expect(vec).toHaveLength(1024)
    vec.forEach((v, i) => expect(v).toBe(TOPIC_EMBEDDING[i]))
  })

  it('match_count=20、p_user_id 透传，且不带任何标签硬过滤参数', async () => {
    const { client, rpcCalls } = makeClient({ rpc: [] })

    await retrieveMaterials(
      client,
      { ...INPUT, currentIntent: '案例引用' },
      { topicEmbedding: TOPIC_EMBEDDING }
    )

    expect(rpcCalls[0].match_count).toBe(20)
    expect(rpcCalls[0].p_user_id).toBe('user-1')
    expect(rpcCalls[0]).not.toHaveProperty('p_usage_filter')
    expect(rpcCalls[0]).not.toHaveProperty('p_material_type')
  })

  it('传入预计算向量时零新增 embedding 调用', async () => {
    const { client } = makeClient({ rpc: [] })
    await retrieveMaterials(client, INPUT, { topicEmbedding: TOPIC_EMBEDDING })
    expect(mockedEmbed).not.toHaveBeenCalled()
  })
})

// ── AC-3 硬阈值 ───────────────────────────────────────────

describe('AC-3：0.55 硬阈值（0.54 排除 / 0.56 保留）', () => {
  it('相似度 0.4 / 0.54 一律不召回；0.55 / 0.56 / 0.8 保留且按相似度排序', async () => {
    const sims: Array<[string, number]> = [
      ['m-040', 0.4],
      ['m-054', 0.54],
      ['m-055', 0.55],
      ['m-056', 0.56],
      ['m-080', 0.8],
    ]
    const rows: Record<string, MockRow> = {}
    for (const [id] of sims) rows[id] = row(id)
    const { client } = makeClient({ rpc: rpcRows(sims), rows })

    const { materials, meta } = await retrieveMaterials(client, INPUT, {
      topicEmbedding: TOPIC_EMBEDDING,
    })

    expect(materials.map((m) => m.materialId)).toEqual(['m-080', 'm-056', 'm-055'])
    expect(materials.map((m) => m.relevanceScore)).toEqual([0.8, 0.56, 0.55])
    expect(meta.recalledCandidateCount).toBe(3)
    expect(meta.threshold).toBe(0.55)
  })
})

// ── AC-4 标签不能决定召回 ─────────────────────────────────

describe('AC-4：标签/类型只能影响带内顺序，永远无法决定召回门槛', () => {
  it('相似度 0.8 但类型/usage 全不匹配 → 照样召回', async () => {
    const { client } = makeClient({
      rpc: rpcRows([['mismatch', 0.8]]),
      rows: {
        mismatch: row('mismatch', {
          material_type: '数据',
          knowledge: { usage_tags: ['观点素材'] },
        }),
      },
    })

    const { materials } = await retrieveMaterials(
      client,
      { ...INPUT, currentIntent: '案例引用' },
      { topicEmbedding: TOPIC_EMBEDDING }
    )

    expect(materials.map((m) => m.materialId)).toContain('mismatch')
    expect(materials[0].materialType).toBe('数据')
  })

  it('相似度 0.4 但类型命中 + 主题词命中 → 仍然排除（标签不能抬门槛）', async () => {
    const { client, rpcCalls } = makeClient({
      rpc: rpcRows([['tagged-low', 0.4]]),
      rows: {
        'tagged-low': row('tagged-low', {
          material_type: '案例',
          related_topics: ['创业'],
          knowledge: { usage_tags: ['案例素材'] },
        }),
      },
    })

    const { materials, meta } = await retrieveMaterials(
      client,
      { userId: 'user-1', currentTopic: '创业起步复盘', currentIntent: '案例引用' },
      { topicEmbedding: TOPIC_EMBEDDING }
    )

    expect(materials).toEqual([])
    expect(meta.recalledCandidateCount).toBe(0)
    // RPC 入参依然不带硬过滤——排除发生在应用层阈值
    expect(rpcCalls[0]).not.toHaveProperty('p_usage_filter')
  })
})

// ── AC-5 selected ─────────────────────────────────────────

describe('AC-5：selectedMaterialIds 最高优先级', () => {
  function setup() {
    return makeClient({
      rpc: rpcRows([
        ['s1', 0.9], // selected 同时出现在自动召回 → 必须去重
        ['a1', 0.82],
        ['a2', 0.76],
        ['a3', 0.7],
        ['a4', 0.66],
        ['a5', 0.62],
        ['a6', 0.6],
        ['a7', 0.58],
      ]),
      rows: {
        s1: row('s1', { material_type: '观点' }),
        a1: row('a1'),
        a2: row('a2'),
        a3: row('a3'),
        a4: row('a4'),
        a5: row('a5'),
        a6: row('a6'),
        a7: row('a7'),
      },
    })
  }

  it('命中素材无视阈值强制返回、置顶、score=1、固定理由，并与自动召回去重', async () => {
    const { client } = setup()
    const { materials, meta } = await retrieveMaterials(
      client,
      { ...INPUT, selectedMaterialIds: ['s1', 'missing-id'] },
      { topicEmbedding: TOPIC_EMBEDDING }
    )

    // s1 置顶且只出现一次（即便 RPC 以 0.9 相似度也召回了它）
    expect(materials[0].materialId).toBe('s1')
    expect(materials[0].relevanceScore).toBe(1)
    expect(materials[0].relevanceReason).toBe('用户主动选择')
    expect(materials.filter((m) => m.materialId === 's1')).toHaveLength(1)
    // selected 不占自动召回名额：7 条自动候选按上限取 5
    expect(materials).toHaveLength(6)
    // 自动项保持原始相似度顺序
    expect(materials.slice(1).map((m) => m.materialId)).toEqual([
      'a1', 'a2', 'a3', 'a4', 'a5',
    ])
    // RLS 静默丢弃（不存在/跨用户）的 id 回传
    expect(meta.missingSelectedIds).toEqual(['missing-id'])
  })

  it('超过 10 个截断前 10 个；第 11 个既不查询也不计入 missing', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `s${i + 1}`)
    const rows: Record<string, MockRow> = {}
    for (const id of ids) rows[id] = row(id)
    const { client, inCalls } = makeClient({ rpc: [], rows })

    const { materials, meta } = await retrieveMaterials(
      client,
      { ...INPUT, selectedMaterialIds: ids },
      { topicEmbedding: TOPIC_EMBEDDING }
    )

    expect(materials).toHaveLength(MAX_SELECTED)
    expect(materials.map((m) => m.materialId)).toEqual(ids.slice(0, 10))
    expect(inCalls[0]).toHaveLength(10)
    expect(meta.missingSelectedIds).toEqual([])
  })

  it('图片素材（content=null）selected 也强制返回，content 退化为空串', async () => {
    const { client } = makeClient({
      rpc: [],
      rows: { img: row('img', { content: null, type: 'image' }) },
    })
    const { materials } = await retrieveMaterials(
      client,
      { ...INPUT, selectedMaterialIds: ['img'] },
      { topicEmbedding: TOPIC_EMBEDDING }
    )
    expect(materials[0].materialId).toBe('img')
    expect(materials[0].relevanceScore).toBe(1)
    expect(materials[0].content).toBe('')
  })
})

describe('normalizeSelectedIds：清洗规则', () => {
  it('非数组 → []；过滤非字符串/空白；保序去重；截断 10', () => {
    expect(normalizeSelectedIds(undefined)).toEqual([])
    expect(normalizeSelectedIds('x')).toEqual([])
    expect(normalizeSelectedIds([1, true, null, 'a', ' a ', 'b', 'a'])).toEqual(['a', 'b'])
    const twelve = Array.from({ length: 12 }, (_, i) => `id${i}`)
    expect(normalizeSelectedIds(twelve)).toHaveLength(10)
  })
})

// ── AC-6 降级 ─────────────────────────────────────────────

describe('AC-6：降级不炸', () => {
  it('embedding 返回 null：只返回 selected + degraded=embedding，不调 RPC', async () => {
    mockedEmbed.mockResolvedValue(null)
    const { client, rpcCalls } = makeClient({
      rpc: rpcRows([['a1', 0.9]]),
      rows: { s1: row('s1') },
    })

    const { materials, meta } = await retrieveMaterials(client, {
      ...INPUT,
      selectedMaterialIds: ['s1'],
    })

    expect(materials.map((m) => m.materialId)).toEqual(['s1'])
    expect(materials[0].relevanceScore).toBe(1)
    expect(meta.degraded).toBe('embedding')
    expect(rpcCalls).toHaveLength(0)
  })

  it('embedding 返回 null 且无 selected → 空数组 + degraded=embedding', async () => {
    mockedEmbed.mockResolvedValue(null)
    const { client } = makeClient({ rpc: rpcRows([['a1', 0.9]]) })
    const { materials, meta } = await retrieveMaterials(client, INPUT)
    expect(materials).toEqual([])
    expect(meta.degraded).toBe('embedding')
  })

  it('embedding 直接 throw → 同样降级，不抛错', async () => {
    mockedEmbed.mockRejectedValue(new Error('network down'))
    const { client } = makeClient({ rpc: [] })
    const result = await retrieveMaterials(client, INPUT)
    expect(result.materials).toEqual([])
    expect(result.meta.degraded).toBe('embedding')
  })

  it('RPC 报错：不抛错，selected 仍返回', async () => {
    const { client } = makeClient({
      rpcError: { message: 'boom' },
      rows: { s1: row('s1') },
    })
    const { materials } = await retrieveMaterials(
      client,
      { ...INPUT, selectedMaterialIds: ['s1'] },
      { topicEmbedding: TOPIC_EMBEDDING }
    )
    expect(materials.map((m) => m.materialId)).toEqual(['s1'])
  })

  it("reasonMode='llm' 且返回坏 JSON → 每条回退模板，meta.degraded=llm_reason，不抛错", async () => {
    // 缺 key 时 lib/llm 会直接 missing_api_key 而根本不 fetch，
    // 那样本用例会退化为「缺 key 回退」的假通过，测不到坏 JSON 分支
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key-for-unit')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '这不是JSON' } }] }),
          { status: 200 }
        )
      )
    )
    const { client } = makeClient({
      rpc: rpcRows([['a1', 0.82]]),
      rows: { a1: row('a1', { material_type: '数据', related_topics: ['创业'] }) },
    })

    const { materials, meta } = await retrieveMaterials(
      client,
      INPUT,
      { topicEmbedding: TOPIC_EMBEDDING, reasonMode: 'llm' }
    )

    expect(materials).toHaveLength(1)
    expect(materials[0].relevanceReason).toBe(
      '与主题语义相似度 82%；类型：数据；关联主题：创业'
    )
    expect(meta.degraded).toBe('llm_reason')
    expect(meta.reasonMode).toBe('llm')
  })

  it("reasonMode='llm' 成功 → 使用 LLM 理由，仅 1 次 LLM 调用", async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key-for-unit')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ reasons: [{ id: 'a1', reason: '增长案例可直接参照' }] }) } },
          ],
        }),
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)
    const { client } = makeClient({
      rpc: rpcRows([['a1', 0.82]]),
      rows: { a1: row('a1') },
    })

    const { materials, meta } = await retrieveMaterials(
      client,
      INPUT,
      { topicEmbedding: TOPIC_EMBEDDING, reasonMode: 'llm' }
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(materials[0].relevanceReason).toBe('增长案例可直接参照')
    expect(meta.degraded).toBeNull()
  })

  it("默认 reasonMode='template'：零 LLM 调用，理由为模板", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { client } = makeClient({
      rpc: rpcRows([['a1', 0.7]]),
      rows: { a1: row('a1') },
    })
    const { materials } = await retrieveMaterials(client, INPUT, {
      topicEmbedding: TOPIC_EMBEDDING,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(materials[0].relevanceReason).toBe('与主题语义相似度 70%')
  })
})

// ── 带状比较器（plan 步骤 7 对拍） ────────────────────────

describe('compareCandidates：±0.02 带内软排序', () => {
  const ctx: SoftSignalContext = { intent: '案例引用', topic: '讲一讲创业起步这件事' }

  function cl(id: string, similarity: number, over: Partial<CandidateLike> = {}): CandidateLike {
    return {
      id,
      similarity,
      materialType: null,
      relatedTopics: null,
      usageTags: [],
      ...over,
    }
  }

  it('0.80 无信号 vs 0.79 全信号：不同带 → 0.80 在前（信号无法跨带）', () => {
    const highNoSignal = cl('high', 0.8)
    const lowWithSignals = cl('low', 0.79, {
      materialType: '案例', // +0.03
      relatedTopics: ['创业'], // +0.02
    })
    const sorted = [lowWithSignals, highNoSignal].sort((a, b) => compareCandidates(a, b, ctx))
    expect(sorted[0].id).toBe('high')
  })

  it('0.80 无信号 vs 0.805 全信号：同 0.80 带 → 信号者在前', () => {
    const noSignal = cl('plain', 0.8)
    const withSignals = cl('signaled', 0.805, {
      materialType: '案例',
      relatedTopics: ['创业'],
    })
    const sorted = [noSignal, withSignals].sort((a, b) => compareCandidates(a, b, ctx))
    expect(sorted[0].id).toBe('signaled')
  })

  it('白名单外意图不加分：类型/usage 信号失效，同带按原始相似度排序', () => {
    const plain = cl('plain', 0.81)
    // 类型 + usage 信号只在意图命中白名单时才加分；此处意图无法解析 → 0 加分
    const tagged = cl('tagged', 0.805, {
      materialType: '案例',
      usageTags: ['案例素材'],
    })
    const sorted = [tagged, plain].sort((a, b) =>
      compareCandidates(a, b, { intent: '随便一个不在映射表的意图', topic: '讲一讲创业起步这件事' })
    )
    expect(sorted[0].id).toBe('plain')
  })
})
