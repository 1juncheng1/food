// ============================================================
// WF8：S2 出口经 ExternalTrendData 协议转换（行为保持重构）
//
// getMarketCandidates 的候选映射改为经 ciItemToExternalTrend 标准出口，
// 外部可观测行为必须完全不变（title/topic/marketRefs/contentValue）。
// 同时回归 ciSearch 的 noAdapters 语义：stub 常驻在册后，无真实源
// 仍必须回退估算模式（这是 stub 注册最隐蔽的破坏点）。
// ============================================================

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { getMarketCandidates, getExplorationCandidates, buildExplorationSeeds } from './suggestionSynthesizer'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { InterestLayer } from './types'

// ── S2：mock service client 返回一条 ci_item ──

const centroid = [0.5, 0.5, 0.5, 0.5]

function mockDbWithRows(rows: unknown[]) {
  const node: Record<string, unknown> = {}
  const terminal = Object.assign(vi.fn().mockResolvedValue({ data: rows, error: null }), node)
  node.select = vi.fn(() => node)
  node.gt = vi.fn(() => node)
  node.gte = vi.fn(() => node)
  node.order = vi.fn(() => node)
  node.limit = terminal
  const db = { from: vi.fn(() => node) }
  return { db, terminal }
}

vi.mock('../../ci/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getServiceClient: () => (globalThis as { __wf8Db?: unknown }).__wf8Db,
}))

beforeEach(() => {
  ;(globalThis as { __wf8Db?: unknown }).__wf8Db = undefined
})

const CI_ROW = {
  id: 'ci-1',
  platform: 'web_search',
  external_id: 'ext-1',
  url: 'https://example.com/a',
  title: 'AI 创业观察',
  excerpt: '一段市场摘要',
  ai_analysis: { core_viewpoint: 'AI 降本增效' },
  embedding: [0.5, 0.5, 0.5, 0.5],
  fetched_at: '2026-09-19T07:00:00Z',
  expires_at: '2026-09-26T07:00:00Z',
}

describe('getMarketCandidates：S2 出口协议转换（行为保持）', () => {
  it('映射结果与直接映射逐字段一致（title/topic/marketRefs/contentValue）', async () => {
    const { db } = mockDbWithRows([CI_ROW])
    ;(globalThis as { __wf8Db?: unknown }).__wf8Db = db

    const out = await getMarketCandidates(centroid, 4)
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('ci_market')
    expect(out[0].title).toBe('AI 创业观察')
    expect(out[0].topic).toContain('AI 创业观察')
    expect(out[0].marketRefs).toEqual([{ platform: 'web_search', url: 'https://example.com/a' }])
    expect(out[0].contentValue).toBeGreaterThanOrEqual(0.3)
  })

  it('embedding 维度不匹配的行被跳过（既有过滤行为保持）', async () => {
    const { db } = mockDbWithRows([{ ...CI_ROW, embedding: [1, 2] }])
    ;(globalThis as { __wf8Db?: unknown }).__wf8Db = db
    expect(await getMarketCandidates(centroid, 4)).toEqual([])
  })

  it('service client 缺失 → 静默空数组（既有降级保持）', async () => {
    expect(await getMarketCandidates(centroid, 4)).toEqual([])
  })
})

// ── ciSearch：stub 常驻后 noAdapters 估算模式语义保持 ──

describe('ciSearch noAdapters 语义（stub 注册回归）', () => {
  it('仅有 stub 在册（无真实源）→ noAdapters:true，调用方回退估算模式', async () => {
    vi.stubEnv('TAVILY_API_KEY', '')
    vi.resetModules()
    ;(globalThis as { __wf8Db?: unknown }).__wf8Db = { from: vi.fn() } // findFreshItems 查询桩

    const { ciSearch } = await import('../../ci/service')
    const r = await ciSearch({ topic: '测试主题' })
    expect(r.noAdapters).toBe(true)
    expect(r.items).toEqual([])
  })
})

// ============================================================
// WF11 P1：多兴趣广度 —— buildExplorationSeeds + S4 扩批
// ============================================================

type SeedInput = {
  clusterId?: string
  code: string
  label: string
  layer: InterestLayer
  weight: number
  keywords?: string[]
  summary?: string
  isNegative?: boolean
}

function clusterFixture(p: SeedInput) {
  return {
    clusterId: p.clusterId ?? `cl-${p.code}`,
    code: p.code,
    label: p.label,
    layer: p.layer,
    weight: p.weight,
    summary: p.summary ?? `${p.label}方向摘要`,
    keywords: p.keywords ?? [],
    isNegative: p.isNegative ?? false,
  }
}

describe('buildExplorationSeeds：多兴趣种子与跨簇组合（WF11 P1）', () => {
  it('3 core + 1 exploration + 1 negative：core 按权重排序先选，非负簇补入，最强两 core 额外产 1 条 cross 组合', () => {
    const views = [
      clusterFixture({ code: 'c2', label: '电影解说', layer: 'core', weight: 0.7, keywords: ['悬疑', '剪辑'] }),
      clusterFixture({ code: 'c1', label: 'AI 工具', layer: 'core', weight: 0.9, keywords: ['效率', '自动化', 'agent'] }),
      clusterFixture({ code: 'c3', label: '情感故事', layer: 'core', weight: 0.5, keywords: ['共鸣'] }),
      clusterFixture({ code: 'e1', label: '职场成长', layer: 'exploration', weight: 0.4 }),
      clusterFixture({ code: 'n1', label: '负面方向', layer: 'temporary', weight: 0.1, isNegative: true }),
    ]
    const { seeds, nonCoreLabels, seedClusters } = buildExplorationSeeds(views)

    // 4 个非负簇全部成单簇种子，负簇永不入选
    const singles = seeds.filter((s) => !s.cross)
    expect(singles.map((s) => s.label)).toEqual(['AI 工具', '电影解说', '情感故事', '职场成长'])
    expect(singles.every((s) => s.cross === undefined)).toBe(true)

    // 最强两 core → 1 条跨簇组合，且不占用 6 个单簇名额
    const combos = seeds.filter((s) => s.cross)
    expect(combos).toHaveLength(1)
    expect(combos[0].label).toContain('AI 工具')
    expect(combos[0].label).toContain('电影解说')
    expect(combos[0].cross).toBe(true)
    // 跨簇关键词 = 两簇并集去重前 6
    expect(combos[0].keywords).toEqual(['效率', '自动化', 'agent', '悬疑', '剪辑'])
    // 单簇在前、组合在后（消费方稳定顺序）
    expect(seeds.indexOf(combos[0])).toBe(seeds.length - 1)

    // 未入选的 label（含负簇，与旧 builder 口径一致）交给 prompt 去重
    expect(nonCoreLabels).toEqual(['负面方向'])
    // builder 据此把首张单簇卡绑到最强簇（core_gap 证据链），必须暴露入选视图
    expect(seedClusters[0].clusterId).toBe('cl-c1')
  })

  it('7 个非负簇：单簇种子截断到 6，cross 组合在名额之外仍保留', () => {
    const views = Array.from({ length: 7 }, (_, i) =>
      clusterFixture({ code: `c${i}`, label: `方向${i}`, layer: i < 6 ? 'core' : 'exploration', weight: 0.9 - i * 0.1 }),
    )
    const { seeds } = buildExplorationSeeds(views)
    expect(seeds.filter((s) => !s.cross)).toHaveLength(6)
    expect(seeds.filter((s) => s.cross)).toHaveLength(1)
    expect(seeds).toHaveLength(7)
  })

  it('只有 1 个非负簇：无跨簇组合（凑不出两个方向）', () => {
    const { seeds, nonCoreLabels } = buildExplorationSeeds([
      clusterFixture({ code: 'c1', label: '独居', layer: 'core', weight: 0.8 }),
    ])
    expect(seeds).toHaveLength(1)
    expect(seeds[0].cross).toBeUndefined()
    expect(nonCoreLabels).toEqual([])
  })

  it('无 core 只有 2 个 exploration 簇：回退路径同样能产跨簇组合（新用户不被排除在广度机制外）', () => {
    const { seeds } = buildExplorationSeeds([
      clusterFixture({ code: 'e1', label: '副业', layer: 'exploration', weight: 0.6 }),
      clusterFixture({ code: 'e2', label: '自媒体', layer: 'exploration', weight: 0.5 }),
    ])
    expect(seeds.filter((s) => !s.cross)).toHaveLength(2)
    const combo = seeds.find((s) => s.cross)
    expect(combo?.label).toContain('副业')
    expect(combo?.label).toContain('自媒体')
  })

  it('空簇 / 全负簇：安全返回空种子', () => {
    expect(buildExplorationSeeds([])).toEqual({ seeds: [], nonCoreLabels: [], seedClusters: [] })
    const { seeds } = buildExplorationSeeds([
      clusterFixture({ code: 'n1', label: '不喜欢', layer: 'temporary', weight: 0.9, isNegative: true }),
    ])
    expect(seeds).toEqual([])
  })
})

// ── S4 getExplorationCandidates：opts.count 扩批 + seed_type 回射 ──

let fetchMock: ReturnType<typeof vi.fn>

function mockLlm(items: Array<Record<string, unknown>>) {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  fetchMock = vi.fn(async () => ({
    ok: true,
    text: async () => '',
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ explorations: items }) } }] }),
  }))
  vi.stubGlobal('fetch', fetchMock)
}

const llmItem = (i: number, extra: Record<string, unknown> = {}) => ({
  title: `探索选题${i}`,
  description: `探索描述${i}`,
  topic: `探索主题${i}`,
  content_value: 0.6,
  ...extra,
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('getExplorationCandidates：扩批与跨簇标记（WF11 P1）', () => {
  it('opts.count=16：产 16 条、max_tokens 提到 2600、请求文案参数化到 16', async () => {
    mockLlm(Array.from({ length: 16 }, (_, i) => llmItem(i)))
    const seeds = buildExplorationSeeds([
      clusterFixture({ code: 'c1', label: 'AI 工具', layer: 'core', weight: 0.9 }),
      clusterFixture({ code: 'c2', label: '电影解说', layer: 'core', weight: 0.7 }),
    ]).seeds

    const out = await getExplorationCandidates(seeds, [], { count: 16 })
    expect(out).toHaveLength(16)

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    // token 预算公式化（count * 170）：16 * 170 = 2720
    expect(body.max_tokens).toBe(2720)
    expect(body.messages[1].content).toContain('16')
    // cross 种子必须透传给模型（跨簇组合不能在接线时丢失）
    expect(body.messages[1].content).toContain('AI 工具')
    // prompt 必须要求模型回射 seed_type，否则跨簇标记无处可来
    expect(body.messages[0].content).toContain('seed_type')
    // 多簇覆盖证据链：同样必须要求回射 seed_label
    expect(body.messages[0].content).toContain('seed_label')
  })

  it('LLM 条目 seed_type=cross → Candidate.crossSeed=true；single/缺省 → 无标记；seed_label 原样透传', async () => {
    mockLlm([
      llmItem(1, { seed_type: 'cross', seed_label: '「a」×「b」' }),
      llmItem(2, { seed_type: 'single', seed_label: 'AI 工具' }),
      llmItem(3),
    ])
    const out = await getExplorationCandidates(
      [{ label: '「a」×「b」', summary: 's', keywords: [], cross: true }],
      [],
      { count: 16 },
    )
    expect(out[0].crossSeed).toBe(true)
    expect(out[0].seedLabel).toBe('「a」×「b」')
    expect(out[1].crossSeed).toBeUndefined()
    expect(out[1].seedLabel).toBe('AI 工具')
    expect(out[2].crossSeed).toBeUndefined()
    expect(out[2].seedLabel).toBeUndefined()
  })

  it('默认 count=2（首篇引导路径行为不回归）：LLM 多给也只留 2 条，max_tokens 仍为 700', async () => {
    mockLlm([llmItem(1), llmItem(2), llmItem(3)])
    const out = await getExplorationCandidates([{ label: '独居', summary: 's', keywords: [] }])
    expect(out).toHaveLength(2)
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.max_tokens).toBe(700)
  })

  it('DEEPSEEK_API_KEY 未配置 → 静默空数组（扩批不改变降级语义）', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const out = await getExplorationCandidates(
      [{ label: 'x', summary: 's', keywords: [] }],
      [],
      { count: 16 },
    )
    expect(out).toEqual([])
  })
})
