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
import { scoreCandidate, recentBehaviorCentroid, recentSimilarityOf, tasteFactorFor } from './ranking'
import {
  RANKING_WEIGHTS_V3,
  TREND_FACTOR,
  EXPLORE_SLOT_FACTOR,
  RULE_VERSION,
  TASTE_PENALTY,
  TASTE_PENALTY_NO_REASON,
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
  it('RANKING_WEIGHTS_V3 精确等于批准的公式权重，且和为 1', () => {
    expect(RANKING_WEIGHTS_V3).toEqual({
      recency: 0.26,
      interestMatch: 0.16,
      knowledge: 0.18,
      trend: 0.14,
      recentBehavior: 0.1,
      quality: 0.1,
      explore: 0.06,
    })
    const sum = Object.values(RANKING_WEIGHTS_V3).reduce((a, b) => a + b, 0)
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9)
  })

  it('优先级链成立：近期创作 > 近期兴趣变化 > 知识库 > 历史作品', () => {
    const w = RANKING_WEIGHTS_V3
    const recentInterest = w.trend + w.recentBehavior
    expect(w.recency).toBeGreaterThan(recentInterest)
    expect(recentInterest).toBeGreaterThan(w.knowledge)
    expect(w.knowledge).toBeGreaterThan(w.interestMatch)
  })

  it('RULE_VERSION 与当前规则口径一致（换权重必须换版本，画像可归因）', () => {
    // v5：评分从「写库时算死」改为「读时计算」，推荐卡必须额外携带 ranking_features
    // + embedding 才能被在线重排 → 存量队列整体换血一次（迁移 0018）。
    // 这是最后一次因口径升级而清空队列：此后调评分权重不再需要重建画像。
    // v6：v5 那次换血其实从未发生——升版时迁移 0018 尚未执行进库，
    // insertSuggestions 每次命中"新列不存在"降级、静默剥掉这两列。
    // 实测库里 1331 张卡 embedding 非空 0 张、ranking_features 全是 '{}'，
    // 导致候选→簇匹配恒 0%、在线重排与曝光闭环全部空转。
    // 现在两列已就位，升 v6 只为触发一次真实换血；评分权重一个没动。
    // v7：放宽单成员簇进画像的门槛——含作品级强信号（写完/定稿/发布）的簇，
    // 1 个成员也承认。跨领域创作者「N 篇作品 N 个方向」，实测 23 个原始簇里
    // 21 个是单成员，全被 MIN_MEMBERS=2 滤掉后画像只剩 2 个方向，推荐随之退化。
    // 这是聚类口径变更（进画像的方向集合变了），须触发重建。
    expect(RULE_VERSION).toBe('interest-rules-v7')
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

describe('scoreCandidate v3：七因子精确分值', () => {
  it('手算基准例（recency/knowledge 均不可用 → 权重按 0.56 重新归一）', () => {
    const r = scoreCandidate({
      candidate: cand(), // contentValue 0.8, slot evidence_followup
      semanticSimilarity: 0.7,
      trend: 'rising', // 1
      daysSinceLastInCluster: 2, // 0.95
    })
    // interestMatch = 0.7×0.5 + 0.3×1 = 0.65
    // 可用权重和 = 0.16+0.14+0.10+0.10+0.06 = 0.56
    // (0.16×0.65 + 0.14×1 + 0.10×0.95 + 0.10×0.8 + 0.06×0.4) / 0.56 = 0.443/0.56
    expect(r.score).toBe(0.791)
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

// ── v3 新增维度 ──

describe('scoreCandidate v3：recency / knowledge / taste', () => {
  const base = {
    candidate: cand(),
    semanticSimilarity: 0.7,
    trend: 'stable' as TrendDirection,
    daysSinceLastInCluster: 5,
  }

  it('recency 归一化：(sim-0.4)/0.6，并出现在 breakdown 里', () => {
    const r = scoreCandidate({ ...base, recentSimilarity: 1 })
    expect(r.breakdown.recency).toBe(1)
    const mid = scoreCandidate({ ...base, recentSimilarity: 0.7 })
    expect(mid.breakdown.recency).toBe(0.5)
  })

  it('recency 缺失 → breakdown 不含该键，且其权重按比例分给其余维度（不是按 0 计）', () => {
    const without = scoreCandidate({ ...base, recentSimilarity: null })
    expect(without.breakdown.recency).toBeUndefined()
    const zeroIfNoRedistribute =
      (0.16 * 0.65 + 0.14 * 0.7 + 0.1 * 0.85 + 0.1 * 0.8 + 0.06 * 0.4) / 1
    // 若按 0 计，score 会被 0.26 的权重整体拉低；重分配后不会
    expect(without.score).toBeGreaterThan(zeroIfNoRedistribute)
  })

  it('knowledge：有知识单元时该维度生效；无知识单元（null）时整体不被扣分', () => {
    const withKb = scoreCandidate({ ...base, recentSimilarity: null, knowledgeScore: 0.9 })
    const withoutKb = scoreCandidate({ ...base, recentSimilarity: null, knowledgeScore: null })
    // 有知识库的高覆盖卡必须高于"没有知识库"的同卡——知识资产应当加分
    expect(withKb.score).toBeGreaterThan(withoutKb.score)
    expect(withKb.breakdown.knowledge).toBe(0.9)
    expect(withoutKb.breakdown.knowledge).toBeUndefined()
  })

  it('taste 乘在最外层，只压分不改任何维度观测值', () => {
    const plain = scoreCandidate({ ...base, recentSimilarity: null, knowledgeScore: null })
    const punished = scoreCandidate({
      ...base,
      recentSimilarity: null,
      knowledgeScore: null,
      tasteFactor: TASTE_PENALTY.not_my_direction,
    })
    expect(punished.score).toBeLessThan(plain.score)
    // 维度值本身不变（口味是"能不能要"，不是"这个方向重不重要"）
    expect(punished.breakdown.interestMatch).toBe(plain.breakdown.interestMatch)
    expect(punished.breakdown.trend).toBe(plain.breakdown.trend)
    expect(punished.breakdown.taste).toBe(TASTE_PENALTY.not_my_direction)
  })

  it('recency 只在「整批算不出」时缺席；单张无向量给中性（否则同批不同尺子）', () => {
    expect(recentSimilarityOf(null, [0.1, 0.2])).not.toBeNull()
    // 无质心 = 整批都算不出 → null，全体一致地重分配
    expect(recentSimilarityOf([0.1, 0.2], null)).toBeNull()
    const r = scoreCandidate({ ...base, recentSimilarity: recentSimilarityOf(null, [0.1, 0.2]) })
    expect(r.breakdown.recency).toBe(0.5)
  })

  it('槽位级口味：已经创作过 → 只额外压 continuation，同方向换角度不受累', () => {
    const entry = { penalty: TASTE_PENALTY.already_created, reason: 'already_created' as const }
    expect(tasteFactorFor(entry, 'continuation')).toBe(0.6)
    expect(tasteFactorFor(entry, 'core_gap')).toBe(TASTE_PENALTY.already_created)
    // 未选原因 → 不参与槽位约束
    expect(tasteFactorFor({ penalty: 0.8, reason: null }, 'continuation')).toBe(0.8)
    expect(tasteFactorFor(undefined, 'continuation')).toBe(1)
  })

  it('口味惩罚档位：方向不对最重，难度不合适最轻；未选原因走默认档', () => {
    expect(TASTE_PENALTY.not_my_direction).toBeLessThan(TASTE_PENALTY.not_interesting)
    expect(TASTE_PENALTY.not_interesting).toBeLessThan(TASTE_PENALTY.too_hard)
    expect(TASTE_PENALTY_NO_REASON).toBeGreaterThan(TASTE_PENALTY.not_my_direction)
    expect(TASTE_PENALTY_NO_REASON).toBeLessThan(1)
  })
})

describe('recentBehaviorCentroid', () => {
  const now = new Date('2026-09-24T00:00:00Z')
  const iso = (daysAgo: number) =>
    new Date(now.getTime() - daysAgo * 86_400_000).toISOString()

  it('越新的簇话语权越大：质心偏向近期方向', () => {
    const c = recentBehaviorCentroid(
      [
        { centroid: [1, 0], weight: 1, lastSeenAt: iso(0) },
        { centroid: [0, 1], weight: 1, lastSeenAt: iso(60) },
      ],
      now
    )
    expect(c![0]).toBeGreaterThan(c![1])
  })

  it('无可用质心 → null（调用方据此让权重重分配，而不是拿零向量算相似度）', () => {
    expect(recentBehaviorCentroid([], now)).toBeNull()
    expect(
      recentBehaviorCentroid([{ centroid: null, weight: 1, lastSeenAt: iso(0) }], now)
    ).toBeNull()
  })
})
