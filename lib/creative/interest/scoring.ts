// ============================================================
// Creator Interest Profile —— 评分引擎（纯函数）
//
// 数学口径（RULE v1，全部确定性，可复算可单测）：
//   1. 撤回裁决：delete/unsave/unlike/unfinalize 按 target/project 撤回对应正向事件
//   2. 有效权重 w(e) = baseWeight × reasonFactor × 0.5^(ageDays/45)
//   3. 项目封顶：同 project × 同簇正向贡献 ≤ 3.0；无项目独立 target ≤ 1.5
//      （一次电影测试迭代 V1/V3 也只算一个项目的票，版本刷票结构封顶）
//   4. 负事件不封顶（dismiss 是明确主题负反馈），簇分可负
//   5. 用户内归一化：weight = raw / maxPositiveRaw，截断 [0,1]；负簇 weight=0
//
// 重要：统计层只信事件事实，不读业务表；LLM 失败不惩罚用户（factor=1）。
// ============================================================

import {
  EVENT_REGISTRY,
  LOOSE_TARGET_CAP,
  PROJECT_CAP_PER_CLUSTER,
  SCORING_WINDOW_DAYS,
  WORK_LEVEL_EVENT_TYPES,
} from './config'
import { clusterEvents, type RawCluster } from './clustering'
import { cosineSimilarity } from './vectorMath'
import { ageDays, effectiveWeight, genuineShare } from './weights'

// 权重原语统一在 weights 实现，scoring 保持单入口再导出
export {
  ageDays,
  recencyWeight,
  reasonFactor,
  genuineShare,
  effectiveWeight,
  needsInterpret,
} from './weights'

import type { CreatorEventType, EngineEvent } from './types'

// ───────────────────────── 撤回裁决 ─────────────────────────

interface WithdrawRule {
  trigger: CreatorEventType
  /** 撤回目标：同一 targetId 的事件，或同一 projectId 的事件 */
  matchBy: 'target' | 'project'
  /** 被撤回的事件类型（null = 撤回该目标/项目的全部正向事件） */
  victimTypes: CreatorEventType[] | null
  victimTargetType?: EngineEvent['targetType']
}

const WITHDRAW_RULES: WithdrawRule[] = [
  // 硬删除作品：该作品 target 的全部事件剔除（含它此前的点赞/迭代）
  { trigger: 'work_delete', matchBy: 'target', victimTypes: null, victimTargetType: 'generation' },
  // 删素材：撤回该素材的保存事件
  { trigger: 'material_delete', matchBy: 'target', victimTypes: ['material_save'], victimTargetType: 'script' },
  // 取消收藏/点赞广场：撤回对应正向事件
  { trigger: 'post_unsave', matchBy: 'target', victimTypes: ['post_save'], victimTargetType: 'post' },
  { trigger: 'post_unlike', matchBy: 'target', victimTypes: ['post_like'], victimTargetType: 'post' },
  // 撤回定稿：撤回该项目在撤回时间点之前（含）的定稿事件
  { trigger: 'work_unfinalize', matchBy: 'project', victimTypes: ['work_finalize'] },
]

/**
 * 撤回裁决（target 级状态机，确定性）。
 * 只撤回"发生在撤回动作之前或同时"的正向事件；撤回动作之后又发生的新正向事件保留。
 * 撤回事件本身不参与评分，在此一并剔除；stats_only 事件原样保留。
 */
export function adjudicateWithdrawals(events: EngineEvent[], now: Date = new Date()): EngineEvent[] {
  const sorted = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
  const withdrawnIds = new Set<string>()

  for (const rule of WITHDRAW_RULES) {
    for (const trigger of sorted.filter((e) => e.type === rule.trigger)) {
      const triggerTime = trigger.occurredAt
      for (const e of sorted) {
        if (e.id === trigger.id) continue
        if (rule.victimTypes && !rule.victimTypes.includes(e.type)) continue
        if (rule.victimTargetType && e.targetType !== rule.victimTargetType) continue
        if (e.occurredAt > triggerTime) continue
        if (rule.matchBy === 'target') {
          if (trigger.targetId && e.targetId === trigger.targetId) withdrawnIds.add(e.id)
        } else if (rule.matchBy === 'project') {
          if (trigger.projectId && e.projectId === trigger.projectId) withdrawnIds.add(e.id)
        }
      }
    }
  }

  return sorted.filter(
    (e) =>
      !withdrawnIds.has(e.id) &&
      EVENT_REGISTRY[e.type]?.effect !== 'withdraw' &&
      ageDays(e.occurredAt, now) <= SCORING_WINDOW_DAYS + 1
  )
}

// ───────────────────────── 簇评分 ─────────────────────────

export interface ScoredCluster {
  members: EngineEvent[] // 正向成员（已含几何归属）
  negativeMembers: EngineEvent[] // 负向成员（按最近质心归属）
  centroid: number[]
  rawScore: number
  weight: number
  eventCount: number
  projectCount: number
  firstSeenAt: string
  lastSeenAt: string
  /** genuine+narrative 原因的加权占比（core 门槛用） */
  genuineRatio: number
  /** 是否为负簇（dismiss 多于正向，候选生成整体跳过） */
  isNegative: boolean
}

/** 评分用分组键：项目内归并；无项目的独立作品按 target 各自归并 */
function capGroupKey(e: EngineEvent): { key: string; cap: number } {
  if (e.projectId) return { key: `p:${e.projectId}`, cap: PROJECT_CAP_PER_CLUSTER }
  return { key: `t:${e.targetId ?? e.id}`, cap: LOOSE_TARGET_CAP }
}

function countProjects(members: EngineEvent[]): number {
  return new Set(members.map((m) => (m.projectId ? `p:${m.projectId}` : `t:${m.targetId ?? m.id}`))).size
}

function scoreOneCluster(
  raw: RawCluster,
  negatives: EngineEvent[],
  now: Date
): ScoredCluster {
  // 正向贡献按组封顶
  const groups = new Map<string, { pos: number; cap: number; neg: number }>()
  let genuineNumerator = 0
  let genuineDenominator = 0

  for (const e of raw.members) {
    const w = effectiveWeight(e, now)
    if (w <= 0) continue
    const { key, cap } = capGroupKey(e)
    const g = groups.get(key) ?? { pos: 0, cap, neg: 0 }
    g.pos += w
    groups.set(key, g)
    const baseShare = w * genuineShare(e.interpretation)
    genuineNumerator += baseShare
    genuineDenominator += w
  }
  let rawScore = 0
  for (const g of groups.values()) rawScore += Math.min(g.pos, g.cap)

  // 负事件不封顶，直接扣减
  for (const e of negatives) rawScore += effectiveWeight(e, now)

  const times = raw.members.map((m) => m.occurredAt).sort()
  return {
    members: raw.members,
    negativeMembers: negatives,
    centroid: raw.centroid,
    rawScore,
    weight: 0, // 归一化在全部簇算完后进行
    eventCount: raw.members.length,
    projectCount: countProjects(raw.members),
    firstSeenAt: times[0] ?? now.toISOString(),
    lastSeenAt: times[times.length - 1] ?? now.toISOString(),
    genuineRatio: genuineDenominator > 0 ? genuineNumerator / genuineDenominator : 1,
    isNegative: rawScore <= 0,
  }
}

/**
 * 评分主入口：撤回裁决 → 单遍聚类（正向有向量事件）→ 负事件就近归属 →
 * 项目封顶 → 用户内归一化。
 *
 * 无 embedding 的正向事件不参与几何聚类（事件保留在账本中，M2b build 补向量后纳入）。
 */
export function scoreClusters(events: EngineEvent[], now: Date = new Date()): ScoredCluster[] {
  const survivors = adjudicateWithdrawals(events, now)

  const positive: EngineEvent[] = []
  const negative: EngineEvent[] = []
  for (const e of survivors) {
    const reg = EVENT_REGISTRY[e.type]
    if (!reg) continue
    if (reg.effect === 'contribute' && reg.weight > 0) positive.push(e)
    else if (reg.effect === 'negative') negative.push(e)
  }

  const rawClusters = clusterEvents(positive, now)

  // 负事件按最近质心归属（不设相似度门槛——明确拒绝应影响语义最近的簇）
  const negativesByCluster: EngineEvent[][] = rawClusters.map(() => [])
  for (const e of negative) {
    if (!Array.isArray(e.embedding) || e.embedding.length === 0) continue
    let bestIdx = -1
    let bestSim = -Infinity
    rawClusters.forEach((c, idx) => {
      const sim = cosineSimilarity(c.centroid, e.embedding!)
      if (sim > bestSim) {
        bestSim = sim
        bestIdx = idx
      }
    })
    if (bestIdx >= 0) negativesByCluster[bestIdx].push(e)
  }

  const scored = rawClusters.map((c, i) => scoreOneCluster(c, negativesByCluster[i], now))

  // 用户内归一化（以最大正簇分为 1.0；负簇 weight=0）
  const maxPositive = Math.max(0, ...scored.filter((c) => !c.isNegative).map((c) => c.rawScore))
  if (maxPositive > 0) {
    for (const c of scored) c.weight = c.isNegative ? 0 : Math.min(1, Math.max(0, c.rawScore / maxPositive))
  }

  return scored.sort((a, b) => b.rawScore - a.rawScore)
}

/**
 * 簇内是否含作品级强信号（写完 / 定稿 / 发布）。
 *
 * 这是 CLUSTER_MIN_MEMBERS 的例外通道：跨领域创作者「N 篇作品 N 个方向」，
 * 每簇只有 1 个成员，若无差别按门槛滤掉，画像只剩一两个方向，推荐随之退化。
 * 作品是真实投入，一篇即足以证明一个方向（完整依据见 config.WORK_LEVEL_EVENT_TYPES）。
 *
 * 注意不需要在这里判撤回：scoreClusters 入口已做 adjudicateWithdrawals，
 * 被删除的作品不会出现在 members 里。
 */
export function hasWorkLevelSignal(cluster: ScoredCluster): boolean {
  const types: readonly string[] = WORK_LEVEL_EVENT_TYPES
  return cluster.members.some((m) => types.includes(m.type))
}
