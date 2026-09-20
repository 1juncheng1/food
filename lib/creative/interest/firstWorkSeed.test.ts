// ============================================================
// 首篇创作引导卡（行为B）——纯逻辑单测
//
// 背景：scoreClusters 产出的单成员正向簇会被 CLUSTER_MIN_MEMBERS=2 滤掉，
// 用户完成第 1 篇创作后画像为空簇 → 推荐队列零个性化卡。
// 本模块从"被滤掉的孤立正向簇"中取最新一个做种子，产 1 张相邻方向探索卡。
// ============================================================

import { describe, expect, it, vi } from 'vitest'
import type { ScoredCluster } from './scoring'
import type { EngineEvent } from './types'
import type { Candidate } from './candidates'
import {
  pickFirstWorkSeed,
  toExplorationSeed,
  buildSeedSuggestionInput,
  buildFirstWorkSeedCard,
} from './firstWorkSeed'

// ── 夹具 ──

function ev(id: string, occurredAt: string, topic?: string): EngineEvent {
  return {
    id,
    type: 'work_generate',
    targetType: 'generation',
    targetId: id,
    projectId: null,
    occurredAt,
    embedding: [0.01, 0.02], // 测试不做真实向量运算，维度任意
    ...(topic ? { _topic: topic } : {}),
  } as EngineEvent
}

function cluster(
  id: string,
  members: EngineEvent[],
  lastSeenAt: string,
  isNegative = false,
  rawScore = 1
): ScoredCluster {
  return {
    members,
    negativeMembers: [],
    centroid: [0.01],
    rawScore,
    weight: isNegative ? 0 : 1,
    eventCount: members.length,
    projectCount: 1,
    firstSeenAt: members[0]?.occurredAt ?? lastSeenAt,
    lastSeenAt,
    genuineRatio: 1,
    isNegative,
  }
}

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    source: 'exploration',
    slot: 'exploration',
    title: '小吃摊引流话术实战',
    description: '基于摆摊小吃主题的相邻方向',
    topic: '小吃摊引流话术',
    formHint: '故事文案',
    embedding: null,
    clusterCode: null,
    contentValue: 0.7,
    marketRefs: null,
    ...over,
  }
}

// ── pickFirstWorkSeed ──

describe('pickFirstWorkSeed：从孤立子簇中选首篇种子', () => {
  it('多个非负簇 → 取 lastSeenAt 最新的（用户最近一次创作）', () => {
    const older = cluster('c1', [ev('e1', '2026-09-18T00:00:00Z', '老主题')], '2026-09-18T00:00:00Z')
    const newer = cluster('c2', [ev('e2', '2026-09-19T00:00:00Z', '新主题')], '2026-09-19T00:00:00Z')
    expect(pickFirstWorkSeed([older, newer])?.eventCount).toBe(1)
    expect(pickFirstWorkSeed([older, newer])?.members[0].id).toBe('e2')
  })

  it('只有负簇（兴趣被撤回/点踩）→ null，不产引导卡', () => {
    const neg = cluster('n1', [ev('e1', '2026-09-19T00:00:00Z', '讨厌的主题')], '2026-09-19T00:00:00Z', true, -1)
    expect(pickFirstWorkSeed([neg])).toBeNull()
  })

  it('空数组（事件全部过期/撤回后零子簇）→ null', () => {
    expect(pickFirstWorkSeed([])).toBeNull()
  })
})

// ── toExplorationSeed ──

describe('toExplorationSeed：种子簇 → LLM 探索种子描述', () => {
  it('取最新成员的 topic 做 label，summary 明示"用户刚创作了"', () => {
    const c = cluster('c1', [
      ev('e1', '2026-09-18T00:00:00Z', '老主题'),
      ev('e2', '2026-09-19T00:00:00Z', '摆摊卖小吃怎么起步'),
    ], '2026-09-19T00:00:00Z')
    const seed = toExplorationSeed(c)
    expect(seed).not.toBeNull()
    expect(seed!.label).toBe('摆摊卖小吃怎么起步')
    expect(seed!.summary).toContain('摆摊卖小吃怎么起步')
    expect(seed!.keywords).toEqual([])
  })

  it('成员全部无 topic 摘录 → null（无法构造语义种子，宁可不产卡）', () => {
    const c = cluster('c1', [ev('e1', '2026-09-19T00:00:00Z')], '2026-09-19T00:00:00Z')
    expect(toExplorationSeed(c)).toBeNull()
  })
})

// ── buildSeedSuggestionInput ──

describe('buildSeedSuggestionInput：候选 → 引导卡落库行', () => {
  it('slot/source/clusterCode 固定为 exploration/exploration/no_cluster，并在 evidence 标注首篇种子', () => {
    const cand = candidate()
    const item = buildSeedSuggestionInput(cand, '摆摊卖小吃怎么起步')
    expect(item.slot).toBe('exploration')
    expect(item.source).toBe('exploration')
    expect(item.clusterCode).toBe('no_cluster')
    expect(item.title).toBe('小吃摊引流话术实战')
    expect(item.topic).toBe('小吃摊引流话术')
    // score 由 ranking 内部计算（无簇走 exploration 地板分），契约只保证 [0,1]
    expect(item.score).toBeGreaterThanOrEqual(0)
    expect(item.score).toBeLessThanOrEqual(1)
    expect(item.evidence.first_work_seed).toBe(true)
    expect(item.evidence.seed_topic).toBe('摆摊卖小吃怎么起步')
  })
})

// ── buildFirstWorkSeedCard：编排（LLM/DB mock） ──

vi.mock('./suggestionSynthesizer', () => ({
  getExplorationCandidates: vi.fn(),
}))
vi.mock('./suggestionRepo', () => ({
  insertSuggestions: vi.fn().mockResolvedValue(1),
}))
vi.mock('./reasonAi', () => ({
  generateAiReasons: vi.fn().mockResolvedValue([
    {
      coreQuestion: null,
      whyRecommend: null,
      creationAngle: null,
      relatedKnowledge: [],
      reasonSource: 'template',
    },
  ]),
}))

import { getExplorationCandidates } from './suggestionSynthesizer'
import { insertSuggestions } from './suggestionRepo'

describe('buildFirstWorkSeedCard：端到端编排（mock LLM/DB）', () => {
  it('LLM 返回相邻方向候选 → 落 1 张引导卡', async () => {
    vi.mocked(getExplorationCandidates).mockResolvedValue([candidate()])
    const c = cluster('c1', [ev('e1', '2026-09-19T00:00:00Z', '摆摊卖小吃怎么起步')], '2026-09-19T00:00:00Z')
    const n = await buildFirstWorkSeedCard({} as never, 'user-1', 'build-1', [c])
    expect(n).toBe(1)
    expect(insertSuggestions).toHaveBeenCalledTimes(1)
    const [, , buildId, items] = vi.mocked(insertSuggestions).mock.calls.at(-1)!
    expect(buildId).toBe('build-1')
    expect(items).toHaveLength(1)
    expect(items[0].clusterCode).toBe('no_cluster')
    expect(items[0].slot).toBe('exploration')
  })

  it('LLM 零候选/降级 → 不落卡、返回 0、不触库', async () => {
    vi.mocked(getExplorationCandidates).mockResolvedValue([])
    const c = cluster('c1', [ev('e1', '2026-09-19T00:00:00Z', '摆摊卖小吃怎么起步')], '2026-09-19T00:00:00Z')
    vi.mocked(insertSuggestions).mockClear()
    const n = await buildFirstWorkSeedCard({} as never, 'user-1', 'build-1', [c])
    expect(n).toBe(0)
    expect(insertSuggestions).not.toHaveBeenCalled()
  })

  it('无可用种子（只有负簇）→ 不调 LLM、不落卡', async () => {
    vi.mocked(getExplorationCandidates).mockClear()
    vi.mocked(insertSuggestions).mockClear()
    const neg = cluster('n1', [ev('e1', '2026-09-19T00:00:00Z', '讨厌')], '2026-09-19T00:00:00Z', true, -1)
    const n = await buildFirstWorkSeedCard({} as never, 'user-1', 'build-1', [neg])
    expect(n).toBe(0)
    expect(getExplorationCandidates).not.toHaveBeenCalled()
    expect(insertSuggestions).not.toHaveBeenCalled()
  })
})
