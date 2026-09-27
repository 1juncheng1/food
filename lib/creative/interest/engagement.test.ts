// ============================================================
// engagement.test.ts —— 曝光—反馈闭环的三条不可动摇性质
//
//   P1 零数据中性：没有曝光记录的卡/簇一律 1.0（新卡新方向不能被先验惩罚）
//   P2 有界：乘子永远在 [FLOOR, CAP] 内（既打不死也捧不上天）
//   P3 只看负向不看恶意：点过就不算看腻；样本不足不学
// ============================================================

import { describe, expect, it } from 'vitest'
import {
  buildEngagementMaps,
  clusterEngagementFactor,
  engagementFactor,
  exposureFatigueFactor,
} from './engagement'
import {
  CTR_FACTOR_CAP,
  CTR_FACTOR_FLOOR,
  CTR_MIN_SAMPLE,
  FATIGUE_FLOOR,
  FATIGUE_FREE_IMPRESSIONS,
} from './config'

describe('① 单卡曝光疲劳', () => {
  it('P1 零曝光 / 少量曝光一律不罚（新卡需要机会）', () => {
    expect(exposureFatigueFactor(0, 0)).toBe(1)
    expect(exposureFatigueFactor(1, 0)).toBe(1)
    expect(exposureFatigueFactor(FATIGUE_FREE_IMPRESSIONS, 0)).toBe(1)
  })

  it('P3 点过就不再算"看腻"——点过恰恰说明它是对的', () => {
    expect(exposureFatigueFactor(20, 1)).toBe(1)
    expect(exposureFatigueFactor(20, 3)).toBe(1)
  })

  it('曝光越多降得越多，且单调不增', () => {
    const seq = [3, 5, 8, 12, 20].map((n) => exposureFatigueFactor(n, 0))
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeLessThan(seq[i - 1])
    }
  })

  it('P2 有界：衰减到地板为止，永远不会归零（看腻≠消失）', () => {
    for (const n of [3, 10, 50, 200, 5000]) {
      const f = exposureFatigueFactor(n, 0)
      expect(f).toBeGreaterThanOrEqual(FATIGUE_FLOOR)
      expect(f).toBeLessThanOrEqual(1)
    }
    expect(exposureFatigueFactor(5000, 0)).toBeCloseTo(FATIGUE_FLOOR, 3)
  })

  it('脏数据（NaN/负数）不罚，退回中性', () => {
    expect(exposureFatigueFactor(Number.NaN, 0)).toBe(1)
    expect(exposureFatigueFactor(-5, 0)).toBe(1)
  })
})

describe('② 簇级互动率', () => {
  it('P1 零数据 / 样本不足不学（3 次曝光没点击不能判方向死刑）', () => {
    expect(clusterEngagementFactor(0, 0)).toBe(1)
    expect(clusterEngagementFactor(CTR_MIN_SAMPLE - 1, 0)).toBe(1)
  })

  it('长期展示却无人点击 → 降到先验之下（系统真的学会了嫌弃这个方向）', () => {
    const f = clusterEngagementFactor(20, 0)
    expect(f).toBeLessThan(1)
    expect(f).toBeGreaterThanOrEqual(CTR_FACTOR_FLOOR)
  })

  it('互动率高于先验 → 上浮（学得会偏好）', () => {
    expect(clusterEngagementFactor(20, 3)).toBeGreaterThan(1)
  })

  it('互动率恰好等于先验 → 中性（1 次点击 / 20 次曝光 = 先验 5%）', () => {
    expect(clusterEngagementFactor(20, 1)).toBeCloseTo(1, 6)
  })

  it('P2 有界：无论样本多极端都不越界', () => {
    for (const [imp, clk] of [
      [10, 0],
      [100, 0],
      [1000, 0],
      [10, 10],
      [100, 100],
      [1000, 999],
    ]) {
      const f = clusterEngagementFactor(imp, clk)
      expect(f).toBeGreaterThanOrEqual(CTR_FACTOR_FLOOR)
      expect(f).toBeLessThanOrEqual(CTR_FACTOR_CAP)
    }
  })

  it('平滑生效：1/8 不会被视为 12.5% 命中率（不是 1/0.05 倍那么夸张）', () => {
    const naive = 0.125 / 0.05 // 2.5
    expect(clusterEngagementFactor(8, 1)).toBeLessThan(naive)
  })
})

describe('合成乘子', () => {
  it('是两层相乘，且缺任一/两者都为中性 1', () => {
    expect(engagementFactor(undefined, undefined)).toBe(1)
    expect(engagementFactor({ impressions: 12, clicks: 0 }, undefined)).toBeCloseTo(
      exposureFatigueFactor(12, 0),
      3
    )
    expect(engagementFactor(undefined, { impressions: 20, clicks: 0 })).toBeCloseTo(
      clusterEngagementFactor(20, 0),
      3
    )
  })
})

describe('事件聚合', () => {
  const clusterByCard = new Map([
    ['c1', 'cluster_a'],
    ['c2', 'cluster_a'],
    ['c3', 'cluster_b'],
  ])

  it('按卡与按簇同时聚合', () => {
    const { byCard, byCluster } = buildEngagementMaps(
      [
        { target_id: 'c1', event_type: 'recommend_impression' },
        { target_id: 'c1', event_type: 'recommend_impression' },
        { target_id: 'c1', event_type: 'recommend_click' },
        { target_id: 'c2', event_type: 'recommend_impression' },
        { target_id: 'c3', event_type: 'recommend_impression' },
      ],
      clusterByCard
    )
    expect(byCard.get('c1')).toEqual({ impressions: 2, clicks: 1 })
    expect(byCard.get('c2')).toEqual({ impressions: 1, clicks: 0 })
    // cluster_a = c1(2 曝光 1 点击) + c2(1 曝光)
    expect(byCluster.get('cluster_a')).toEqual({ impressions: 3, clicks: 1 })
    expect(byCluster.get('cluster_b')).toEqual({ impressions: 1, clicks: 0 })
  })

  it('no_cluster 不参与簇级学习（兜底桶不是方向，不该为归因失败挨罚）', () => {
    const { byCard, byCluster } = buildEngagementMaps(
      [
        { target_id: 'c9', event_type: 'recommend_impression' },
        { target_id: 'c9', event_type: 'recommend_impression' },
        { target_id: 'c9', event_type: 'recommend_impression' },
      ],
      new Map([['c9', 'no_cluster']])
    )
    // 单卡疲劳照常记账
    expect(byCard.get('c9')).toEqual({ impressions: 3, clicks: 0 })
    // 但不产生任何簇级统计
    expect(byCluster.has('no_cluster')).toBe(false)
    expect(byCluster.size).toBe(0)
  })

  it('映射不到簇的卡只进按卡表，不污染簇统计（已退场卡不该影响当下这批的次序）', () => {
    const { byCard, byCluster } = buildEngagementMaps(
      [{ target_id: 'gone-card', event_type: 'recommend_impression' }],
      clusterByCard
    )
    expect(byCard.get('gone-card')).toEqual({ impressions: 1, clicks: 0 })
    expect(byCluster.has('gone-card')).toBe(false)
    expect(byCluster.size).toBe(0)
  })

  it('脏行静默跳过：无 target_id / 无关事件类型 / 非对象', () => {
    const { byCard, byCluster } = buildEngagementMaps(
      [
        { event_type: 'recommend_impression' },
        { target_id: 'c1', event_type: 'work_generate' },
        { target_id: null, event_type: 'recommend_click' },
        { target_id: 123, event_type: 'recommend_click' },
      ],
      clusterByCard
    )
    expect(byCard.size).toBe(0)
    expect(byCluster.size).toBe(0)
  })

  it('空输入 → 空表 → 全中性（查询失败的退路）', () => {
    const { byCard, byCluster } = buildEngagementMaps([], clusterByCard)
    expect(byCard.size).toBe(0)
    expect(byCluster.size).toBe(0)
    expect(engagementFactor(byCard.get('x'), byCluster.get('y'))).toBe(1)
  })
})
