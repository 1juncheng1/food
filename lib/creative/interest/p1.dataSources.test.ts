// ============================================================
// P1：接上三个「已建未接」数据源 —— 单测
//
// 覆盖三块：
//   A. 证据事实包 3 类 → 7 类（evidenceFacts + reasonAi 模板理由）
//   B. S6 知识候选源（creator_knowledge → 推荐卡）
//   C. S7 风格适配（style_profiles → S4 prompt + 硬禁忌过滤）
//
// 共同红线回归：新增数据源不得改变"无数据时零影响"的既有行为——
// 老用户/未迁移环境必须和改动前完全一致。
// ============================================================

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  accumulateFact,
  buildEvidenceFacts,
  factToText,
  EVIDENCE_FACT_TYPES,
} from './evidenceFacts'
import { getKnowledgeCandidates, matchKnowledgeCluster } from './candidates'
import {
  filterByAvoid,
  formatStyleHintsForPrompt,
  normalizeStyleHints,
  violatesAvoid,
  type StyleHints,
} from './styleHints'
import { buildReasonText } from './reasonAi'

// ── A. 证据事实包 ──

describe('证据事实包（P1：3 类 → 7 类）', () => {
  it('七类事件全部累加进计数', () => {
    const counts = {}
    for (const t of [
      'work_generate',
      'work_finalize',
      'material_save',
      'work_edit',
      'recommend_adopt',
      'inspiration_analyze',
      'topic_search',
    ]) {
      accumulateFact(counts, t)
    }
    expect(Object.keys(counts).sort()).toEqual([...EVIDENCE_FACT_TYPES].sort())
  })

  it('改稿/采纳/分析/搜索不再被丢弃（这是本次扩展的直接目标）', () => {
    const counts = {}
    accumulateFact(counts, 'work_edit')
    accumulateFact(counts, 'recommend_adopt')
    accumulateFact(counts, 'inspiration_analyze')
    accumulateFact(counts, 'topic_search')
    expect(buildEvidenceFacts(counts, 'AI 创业')).toEqual([
      { type: 'edit', count: 1, cluster_label: 'AI 创业' },
      { type: 'adopt', count: 1, cluster_label: 'AI 创业' },
      { type: 'analyze', count: 1, cluster_label: 'AI 创业' },
      { type: 'search', count: 1, cluster_label: 'AI 创业' },
    ])
  })

  it('只输出计数 > 0 的项（零计数会让无事实候选误过 AI 理由准入）', () => {
    const counts = { create: 2, finalize: 0, save: 0 }
    expect(buildEvidenceFacts(counts, 'X').map((f) => f.type)).toEqual(['create'])
  })

  it('输出顺序固定为 EVIDENCE_FACT_TYPES（同一簇多次 build 可 diff）', () => {
    const counts = { search: 1, create: 1, edit: 1 }
    expect(buildEvidenceFacts(counts, 'X').map((f) => f.type)).toEqual(['create', 'edit', 'search'])
  })

  it('负向事件 recommend_dismiss 不进事实包（理由里写"你点过 N 次✕"既冒犯又无信息）', () => {
    const counts = {}
    accumulateFact(counts, 'recommend_dismiss')
    expect(buildEvidenceFacts(counts, 'X')).toEqual([])
  })

  it('未知事件类型忽略，不污染计数', () => {
    const counts = { create: 1 }
    accumulateFact(counts, 'post_like')
    accumulateFact(counts, undefined)
    expect(counts).toEqual({ create: 1 })
  })

  it('单条事实可翻译成中文短语（AI 理由与模板理由同一口径）', () => {
    expect(factToText({ type: 'create', count: 3 })).toBe('生成 3 篇')
    expect(factToText({ type: 'adopt', count: 2 })).toBe('采纳过 2 条同方向推荐')
  })

  it('模板理由仍能复述方向名（create 是唯一主干句）', () => {
    const text = buildReasonText({
      slot: 'core_gap',
      clusterCode: 'c1',
      evidence: {
        facts: [
          { type: 'create', count: 3, cluster_label: 'AI 创业' },
          { type: 'edit', count: 2, cluster_label: 'AI 创业' },
        ],
      },
    })
    expect(text).toContain('生成 3 篇「AI 创业」')
    expect(text).toContain('改过 2 次稿')
  })
})

// ── B. S6 知识候选源 ──

/** 最小可用的知识单元行（source_item_ids 必须 ≥2，否则不承认是"跨素材归纳"） */
function knowledgeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'k1',
    user_id: 'u1',
    concept: '小而美的 SaaS 定价',
    claim: '低频高客单的工具不适合按月订阅，应按次或按结果计费。',
    kind: '观点',
    domain_scope: ['SaaS', '创业'],
    confidence: 0.8,
    source_item_ids: ['s1', 's2'],
    source_count: 2,
    status: '已确认',
    ...over,
  }
}

/** 链式 stub：select().eq().eq().order().limit() */
function makeKnowledgeClient(rows: unknown[], error: { message: string } | null = null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: async () => ({ data: rows, error }),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

describe('S6 知识候选源（creator_knowledge → 推荐卡）', () => {
  it('已确认且置信度达标的单元会变成推荐卡', async () => {
    const cands = await getKnowledgeCandidates(
      makeKnowledgeClient([knowledgeRow()]),
      'u1',
      []
    )
    expect(cands).toHaveLength(1)
    expect(cands[0].source).toBe('creator_knowledge')
    expect(cands[0].title).toBe('小而美的 SaaS 定价')
    expect(cands[0].description).toContain('你确认过的知识')
  })

  it('候选态（AI 归纳未确认）不产出——与"候选不进注入"的授权链一致', async () => {
    const cands = await getKnowledgeCandidates(
      makeKnowledgeClient([knowledgeRow({ status: '候选' })]),
      'u1',
      []
    )
    expect(cands).toEqual([])
  })

  it('已确认但置信度低于 0.6 不产出', async () => {
    const cands = await getKnowledgeCandidates(
      makeKnowledgeClient([knowledgeRow({ confidence: 0.5 })]),
      'u1',
      []
    )
    expect(cands).toEqual([])
  })

  it('来源不足 2 条素材的单元不产出（那只是单条素材的复制，不算知识）', async () => {
    const cands = await getKnowledgeCandidates(
      makeKnowledgeClient([knowledgeRow({ source_item_ids: ['s1'], source_count: 1 })]),
      'u1',
      []
    )
    expect(cands).toEqual([])
  })

  it('domain_scope 命中簇关键词时带上 forceClusterCode（否则无向量的卡永远拿不到事实包）', async () => {
    const cands = await getKnowledgeCandidates(
      makeKnowledgeClient([knowledgeRow()]),
      'u1',
      [{ code: 'c_saas', label: 'SaaS 增长', keywords: ['创业'] }]
    )
    expect(cands[0].forceClusterCode).toBe('c_saas')
  })

  it('domain_scope 无重叠时不强行绑簇（宁可无簇，也不模糊匹配）', async () => {
    const cands = await getKnowledgeCandidates(
      makeKnowledgeClient([knowledgeRow()]),
      'u1',
      [{ code: 'c_film', label: '电影解说', keywords: ['悬疑'] }]
    )
    expect(cands[0].forceClusterCode).toBeNull()
  })

  it('表不存在/查询失败 → 静默空数组（老库未迁移是真实部署状态）', async () => {
    const cands = await getKnowledgeCandidates(
      makeKnowledgeClient([], { message: 'relation "creator_knowledge" does not exist' }),
      'u1',
      []
    )
    expect(cands).toEqual([])
  })

  it('同等置信度下优先来源更多的单元（跨素材越多越可信）', async () => {
    const cands = await getKnowledgeCandidates(
      makeKnowledgeClient([
        knowledgeRow({ id: 'a', concept: '少源归纳', source_item_ids: ['s1', 's2'], source_count: 2 }),
        knowledgeRow({
          id: 'b',
          concept: '多源归纳',
          source_item_ids: ['s1', 's2', 's3'],
          source_count: 5,
        }),
      ]),
      'u1',
      []
    )
    expect(cands.map((c) => c.title)).toEqual(['多源归纳', '少源归纳'])
  })

  it('置信度更高的排在前面（优先于来源条数）', async () => {
    const cands = await getKnowledgeCandidates(
      makeKnowledgeClient([
        knowledgeRow({ id: 'a', concept: '低置信', confidence: 0.7, source_count: 9 }),
        knowledgeRow({ id: 'b', concept: '高置信', confidence: 0.95, source_count: 2 }),
      ]),
      'u1',
      []
    )
    expect(cands[0].title).toBe('高置信')
  })

  it('最多产出 3 条（避免知识库大的用户被刷屏）', async () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      knowledgeRow({ id: `k${i}`, concept: `概念${i}` })
    )
    const cands = await getKnowledgeCandidates(makeKnowledgeClient(rows), 'u1', [])
    expect(cands).toHaveLength(3)
  })
})

describe('matchKnowledgeCluster：domain_scope × 簇文本', () => {
  const clusters = [{ code: 'c1', label: 'AI 创业', keywords: ['融资'] }]

  it('簇关键词包含在 scope 内 → 命中（受控词表存在粒度差异，不能要求全等）', () => {
    expect(matchKnowledgeCluster(['AI 创业实战'], clusters)).toBe('c1')
  })

  it('scope 是簇关键词的子串 → 命中', () => {
    expect(matchKnowledgeCluster(['AI'], clusters)).toBe('c1')
  })

  it('scope 为空 → 不命中（没有范围信息的知识不该被硬塞进某个簇）', () => {
    expect(matchKnowledgeCluster([], clusters)).toBeNull()
  })
})

// ── C. S7 风格适配 ──

describe('S7 风格适配', () => {
  it('无风格数据（新用户）→ null，prompt 与过滤全程 no-op', () => {
    expect(normalizeStyleHints(null)).toBeNull()
    expect(normalizeStyleHints({})).toBeNull()
    expect(formatStyleHintsForPrompt(null)).toBe('')
  })

  it('风格数据非空 → 产出软引导 + 硬禁忌', () => {
    const hints = normalizeStyleHints({
      favorite_elements: ['具体案例', '数据支撑'],
      avoid_elements: ['空洞鸡汤'],
      topic_preferences: ['创业'],
    })
    expect(hints?.favorites).toEqual(['具体案例', '数据支撑'])
    expect(hints?.avoids).toEqual(['空洞鸡汤'])
    expect(formatStyleHintsForPrompt(hints)).toContain('空洞鸡汤')
  })

  it('命中回避元素的候选被剔除（硬约束）', () => {
    const hints: StyleHints = { favorites: [], topics: [], avoids: ['空洞鸡汤'] }
    const kept = filterByAvoid(
      [
        { title: '写一篇空洞鸡汤', description: 'd', topic: 't' },
        { title: '用数据复盘一次失败', description: 'd', topic: 't' },
      ],
      hints
    )
    expect(kept.map((c) => c.title)).toEqual(['用数据复盘一次失败'])
  })

  it('只匹配用户看得见的 title/description/topic，不误杀内部结构', () => {
    expect(
      violatesAvoid({ title: '正常选题', description: 'd', topic: 't' }, ['空洞鸡汤'])
    ).toBe(false)
  })

  it('无回避项时原样返回（零开销、不改变顺序）', () => {
    const list = [{ title: 'a', description: 'd', topic: 't' }]
    expect(filterByAvoid(list, null)).toBe(list)
    expect(filterByAvoid(list, { favorites: [], topics: [], avoids: [] })).toBe(list)
  })
})
