// ============================================================
// engagement.ts —— 曝光—反馈闭环
//
// 刻意不升 RULE_VERSION：这层不改 scoreCandidate 公式，也不改 ranking_features
// 的结构，只在读路径对算完的分乘一个可观测的乘子。升版本会强制全部用户清空
// 队列重建，代价与收益不成比例。
//
// 为什么要有这一层：
//   排序此前只吃"内容特征"（向量相似度/趋势/知识覆盖），完全不吃"用户怎么对
//   待这些推荐"。而用户的行为一直在被采集：曝光、点击、✕ 都在 creator_events
//   里，只是没有回流到排序。缺了这一环，系统永远只能推荐"看起来该推的"，
//   学不会"用户其实不想要的"。
//
// 两层口径不同，刻意分开：
//   ① exposureFatigueFactor —— 单卡：这张卡展示了很多次却没人点 → 降权。
//      作用是让队列**轮换**，防止一张卡长期霸榜。
//   ② clusterEngagementFactor —— 簇级：这个方向的卡整体点击率低于先验 → 降权。
//      作用是让系统**学习**方向偏好，并推广到该方向后续的新卡。
//
// 三条不可动摇的性质（任何改动都要保住）：
//   P1 零数据中性：没有曝光记录的卡/簇一律 1.0。新用户、新方向绝不能被先验惩罚。
//   P2 有界：乘子永远在 [FLOOR, CAP] 内，不会把卡打死也不会捧上天。
//   P3 只看负向不看恶意：点过就不再算"看腻"；样本不足不学。
// ============================================================

import {
  CTR_FACTOR_CAP,
  CTR_FACTOR_FLOOR,
  CTR_MIN_SAMPLE,
  CTR_PRIOR_ALPHA,
  CTR_PRIOR_BETA,
  FATIGUE_DECAY_IMPRESSIONS,
  FATIGUE_FLOOR,
  FATIGUE_FREE_IMPRESSIONS,
} from './config'

/**
 * 归因失败的兜底桶。它不是兴趣方向，不参与簇级学习 —— 理由见 buildEngagementMaps。
 */
export const NO_CLUSTER = 'no_cluster'

export interface EngagementStats {
  impressions: number
  clicks: number
}

/** 卡片 id → 该卡的曝光/点击 */
export type CardEngagementMap = Map<string, EngagementStats>
/** cluster_code → 该簇（经该簇的卡）累计的曝光/点击 */
export type ClusterEngagementMap = Map<string, EngagementStats>

/**
 * ① 单卡曝光疲劳乘子。
 *
 * 点过的卡直接返回 1 —— "看腻了"的证据是"反复看到却不点"，点过恰恰说明
 * 它是对的，此时再罚它就自相矛盾了。
 *
 * 曝光是有天然上限的：impression 上报按天幂等（dailyKey），卡 14 天过期，
 * 所以 impressions 最多约 14，不会出现"无限衰减到 0"。
 */
export function exposureFatigueFactor(impressions: number, clicks: number): number {
  if (!Number.isFinite(clicks) || clicks > 0) return 1
  if (!Number.isFinite(impressions) || impressions <= FATIGUE_FREE_IMPRESSIONS) return 1
  const excess = impressions - FATIGUE_FREE_IMPRESSIONS
  return (
    FATIGUE_FLOOR + (1 - FATIGUE_FLOOR) * Math.exp(-excess / FATIGUE_DECAY_IMPRESSIONS)
  )
}

/**
 * ② 簇级互动率乘子（拉普拉斯平滑的 CTR / 先验 CTR，再钳制）。
 *
 * 样本不足直接返回 1：3 次曝光没点击就把一个方向判死，是把噪声当信号。
 * 平滑的意义同理 —— 1/3 不该等价于 33% 命中率，它只是"还不知道"。
 */
export function clusterEngagementFactor(impressions: number, clicks: number): number {
  if (!Number.isFinite(impressions) || impressions < CTR_MIN_SAMPLE) return 1
  const safeClicks = Number.isFinite(clicks) ? Math.max(0, clicks) : 0
  const priorMean = CTR_PRIOR_ALPHA / (CTR_PRIOR_ALPHA + CTR_PRIOR_BETA)
  const ctr =
    (safeClicks + CTR_PRIOR_ALPHA) / (impressions + CTR_PRIOR_ALPHA + CTR_PRIOR_BETA)
  const ratio = ctr / priorMean
  return Math.max(CTR_FACTOR_FLOOR, Math.min(CTR_FACTOR_CAP, ratio))
}

/** 一张卡的最终互动乘子 = 单卡疲劳 × 簇级学习 */
export function engagementFactor(
  card: EngagementStats | undefined,
  cluster: EngagementStats | undefined
): number {
  const f1 = exposureFatigueFactor(card?.impressions ?? 0, card?.clicks ?? 0)
  const f2 = clusterEngagementFactor(cluster?.impressions ?? 0, cluster?.clicks ?? 0)
  return Math.round(f1 * f2 * 1000) / 1000
}

/**
 * 把原始事件行聚合成「按卡」与「按簇」两张表。
 *
 * impression/click 事件不带 payload（只有 target_id），簇归属由调用方传入的
 * 「卡片 id → cluster_code」字典补齐。
 *
 * 这个字典必须是持久的（来自 interest_suggestions），不能只装"正在排的这批卡"：
 * 卡 14 天过期，而簇级学习要攒够 8 次曝光才开口，等样本够时承载它的卡早退场了。
 * 字典不持久 = 簇级统计恒为空 = 学习无法推广到新卡 = 这一层白做。
 *
 * 容错：认不出的行静默跳过，绝不抛。
 */
export function buildEngagementMaps(
  rows: readonly Record<string, unknown>[],
  clusterByCardId: Map<string, string>
): { byCard: CardEngagementMap; byCluster: ClusterEngagementMap } {
  const byCard: CardEngagementMap = new Map()
  const byCluster: ClusterEngagementMap = new Map()

  const bump = (m: Map<string, EngagementStats>, key: string, isClick: boolean) => {
    const cur = m.get(key) ?? { impressions: 0, clicks: 0 }
    if (isClick) {
      cur.clicks += 1
    } else {
      cur.impressions += 1
    }
    m.set(key, cur)
  }

  for (const r of rows) {
    const id = typeof r.target_id === 'string' ? r.target_id : null
    if (!id) continue
    const type = typeof r.event_type === 'string' ? r.event_type : ''
    const isClick = type === 'recommend_click'
    if (!isClick && type !== 'recommend_impression') continue

    bump(byCard, id, isClick)

    const code = clusterByCardId.get(id)
    // no_cluster 不进簇级统计。它是"系统没认出这张卡属于哪个方向"的兜底桶，
    // 桶里装的是互不相关的卡；给它学一个统一点击率再套回每一张，等于让一张
    // 卡为系统的归因失败挨罚 —— 既不公平也不可解释。单卡疲劳照常生效，
    // 那才是"这张卡到底有没有人理"的诚实信号。
    if (code && code !== NO_CLUSTER) bump(byCluster, code, isClick)
  }

  return { byCard, byCluster }
}
