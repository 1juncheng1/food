// ============================================================
// WF5：评分公式 v2 —— Score = InterestMatch×0.4 + RecentBehavior×0.2
//                              + Trend×0.2 + Quality×0.1 + Explore×0.1
//
// 旧 v1（interestFit/contentValue/purposeFit/novelty/timeliness 0.34/0.24/
// 0.16/0.14/0.12）被整体替换：权重全部收敛进 config.RANKING_WEIGHTS_V2，
// 业务代码零魔法数；breakdown 键名同步更换（旧卡不回刷，下次 build 起新分）。
// InterestMatch = 0.7×语义匹配 + 0.3×标签命中（WF4 接入真实标签，当前
// tagOverlapRatio 缺省 1 = 标签维度按满分兜底，不打压无标签旧数据）。
// ============================================================

import { describe, expect, it } from 'vitest'
import { scoreCandidate } from './ranking'
import {
  RANKING_WEIGHTS_V2,
  TREND_FACTOR,
  EXPLORE_SLOT_FACTOR,
  RULE_VERSION,
} from './config'
import type { Candidate } from './candidates'
import type { TrendDirection } from './types'

function cand(over: Partial<Candidate> = {}): Candidate {
  return {
    source: 'own_inspiration',
    slot: 'evidence_followup',
    title: 'T',
    description: 'D',
    topic: 'AI创业',
    formHint: '其他',
    embedding: null,
    clusterCode: null,
    contentValue: 0.8,
    marketRefs: null,
    ...over,
  }
}

describe('WF5 config：v2 权重与映射（可动态调整的唯一参数面）', () => {
  it('RANKING_WEIGHTS_V2 精确等于批准的公式权重，且和为 1', () => {
    expect(RANKING_WEIGHTS_V2).toEqual({
      interestMatch: 0.4,
      recentBehavior: 0.2,
      trend: 0.2,
      quality: 0.1,
      explore: 0.1,
    })
    const sum = Object.values(RANKING_WEIGHTS_V2).reduce((a, b) => a + b, 0)
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9)
  })

  it('RULE_VERSION 升版 interest-rules-v2（换权重必须换版本，画像可归因）', () => {
    expect(RULE_VERSION).toBe('interest-rules-v2')
  })

  it('TREND_FACTOR：rising 1 / stable 0.7 / declining 0.3 / dormant 0.15', () => {
    expect(TREND_FACTOR).toEqual({ rising: 1, stable: 0.7, declining: 0.3, dormant: 0.15 })
  })

  it('EXPLORE_SLOT_FACTOR：exploration 1 / core_gap 0.55 / evidence_followup 0.4 / continuation 0.2', () => {
    expect(EXPLORE_SLOT_FACTOR).toEqual({
      exploration: 1,
      core_gap: 0.55,
      evidence_followup: 0.4,
      continuation: 0.2,
    })
  })
})

describe('scoreCandidate v2：五因子精确分值', () => {
  it('手算基准例：sim=0.7 → 语义 (0.7-0.4)/0.6=0.5，interestMatch=0.7×0.5+0.3×1=0.65，总分 0.77', () => {
    const r = scoreCandidate({
      candidate: cand(), // contentValue 0.8, slot evidence_followup
      semanticSimilarity: 0.7,
      trend: 'rising', // 1
      daysSinceLastInCluster: 2, // 0.95
    })
    // 0.4×0.65 + 0.2×0.95 + 0.2×1 + 0.1×0.8 + 0.1×0.4 = 0.77
    expect(r.score).toBe(0.77)
    expect(r.breakdown).toEqual({
      interestMatch: 0.65,
      recentBehavior: 0.95,
      trend: 1,
      quality: 0.8,
      explore: 0.4,
    })
  })

  it('breakdown 只含 v2 五键（旧键不得残留）', () => {
    const r = scoreCandidate({
      candidate: cand(),
      semanticSimilarity: 0.6,
      trend: 'stable',
      daysSinceLastInCluster: 5,
    })
    expect(Object.keys(r.breakdown).sort()).toEqual(
      ['explore', 'interestMatch', 'quality', 'recentBehavior', 'trend']
    )
  })

  it('tagOverlapRatio 显式 0 → interestMatch=0.7×语义（WF4 接入前的真实标签兜底契约）', () => {
    const r = scoreCandidate({
      candidate: cand(),
      semanticSimilarity: 0.7, // semantic 0.5
      tagOverlapRatio: 0,
      trend: 'stable',
      daysSinceLastInCluster: 2,
    })
    expect(r.breakdown.interestMatch).toBe(0.35) // 0.7×0.5 + 0.3×0
  })

  it('tagOverlapRatio 越界裁剪到 [0,1]；语义相似度低于地板归 0、高于 1 归 1', () => {
    const low = scoreCandidate({
      candidate: cand(),
      semanticSimilarity: 0.1, // (0.1-0.4)/0.6 < 0 → 0
      tagOverlapRatio: 5,
      trend: 'stable',
      daysSinceLastInCluster: 2,
    })
    expect(low.breakdown.interestMatch).toBe(0.3) // 0.7×0 + 0.3×1（tagOverlap 越界裁剪到 1）
    const high = scoreCandidate({
      candidate: cand(),
      semanticSimilarity: 1.2, // clamp → 1
      trend: 'stable',
      daysSinceLastInCluster: 2,
    })
    expect(high.breakdown.interestMatch).toBe(1) // 0.7×1 + 0.3×1
  })

  it('无簇候选：非探索源语义分 0；探索源给探索地板（保留"探索卡不打高分但不至零"）', () => {
    const plain = scoreCandidate({
      candidate: cand({ source: 'ci_market' }),
      semanticSimilarity: null,
      trend: null,
      daysSinceLastInCluster: null,
    })
    expect(plain.breakdown.interestMatch).toBe(0.3) // 0.7×0 + 0.3×1
    const expl = scoreCandidate({
      candidate: cand({ source: 'exploration', slot: 'exploration' }),
      semanticSimilarity: null,
      trend: null,
      daysSinceLastInCluster: null,
    })
    // interestMatch 0.7×0.3+0.3×1 = 0.51
    expect(expl.breakdown.interestMatch).toBe(0.51)
    expect(plain.breakdown.recentBehavior).toBe(0.5) // 无簇无事件 → 中性
    expect(plain.breakdown.trend).toBe(0.7) // 无信号 → stable 中性
  })
})

describe('scoreCandidate v2：单调性与归一化', () => {
  const base = {
    candidate: cand(),
    semanticSimilarity: 0.7,
    trend: 'stable' as TrendDirection,
    daysSinceLastInCluster: 5,
  }

  it('trend 因子严格单调：rising > stable > declining > dormant', () => {
    const scores = (['rising', 'stable', 'declining', 'dormant'] as TrendDirection[])
      .map((t) => scoreCandidate({ ...base, trend: t }).breakdown.trend)
    expect(scores[0]).toBeGreaterThan(scores[1])
    expect(scores[1]).toBeGreaterThan(scores[2])
    expect(scores[2]).toBeGreaterThan(scores[3])
  })

  it('行为越新 recentBehavior 越高；60 天以上降到 0.15', () => {
    const fresh = scoreCandidate({ ...base, daysSinceLastInCluster: 1 })
    const old = scoreCandidate({ ...base, daysSinceLastInCluster: 90 })
    expect(fresh.breakdown.recentBehavior).toBeGreaterThan(old.breakdown.recentBehavior)
    expect(old.breakdown.recentBehavior).toBe(0.15)
  })

  it('explore 槽位因子：exploration > core_gap > evidence_followup > continuation', () => {
    const slots = (['exploration', 'core_gap', 'evidence_followup', 'continuation'] as const)
      .map((slot) => scoreCandidate({ ...base, candidate: cand({ slot }) }).breakdown.explore)
    for (let i = 1; i < slots.length; i++) expect(slots[i - 1]).toBeGreaterThan(slots[i])
  })

  it('score 恒在 [0,1] 且 3 位小数', () => {
    const r = scoreCandidate({ ...base, candidate: cand({ contentValue: 1 }) })
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(1)
    expect(r.score).toBe(Math.round(r.score * 1000) / 1000)
  })
})
