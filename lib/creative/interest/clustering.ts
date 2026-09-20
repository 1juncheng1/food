// ============================================================
// Creator Interest Profile —— 单遍余弦聚类（纯函数，algo v1）
//
// 算法（参数锁定在 config，换算法 = 新 ALGO_VERSION 全量重跑）：
//   事件按时间正序 → 逐个与已有簇质心比余弦相似度：
//     sim ≥ 1 - 0.28（0.72）→ 归入最相似簇，增量更新加权质心
//     否则 → 开新簇（单事件也成簇，分层阶段再用规则判 temporary）
//   质心 = 成员向量按有效权重（含时间衰减）加权平均。
//
// 为什么是单遍而不是 k-means：用户事件量级百级、主题自然增长，
// 单遍无需预设 k、结果对输入顺序确定（配合时间排序完全可复现）。
// ============================================================

import { CLUSTER_DISTANCE_THRESHOLD } from './config'
import { effectiveWeight } from './weights'
import type { EngineEvent } from './types'
import { cosineSimilarity, weightedCentroid } from './vectorMath'

export interface RawCluster {
  members: EngineEvent[]
  centroid: number[]
  firstSeenAt: string
  lastSeenAt: string
}

const SIMILARITY_FLOOR = 1 - CLUSTER_DISTANCE_THRESHOLD

/**
 * 对正向事件做单遍聚类。
 * 调用方已保证传入的是"正向贡献"事件；本函数只负责几何。
 * 无 1024 维向量的事件跳过（build 补算后下期纳入）。
 */
export function clusterEvents(events: EngineEvent[], now: Date = new Date()): RawCluster[] {
  const sorted = [...events]
    .filter((e) => Array.isArray(e.embedding) && e.embedding!.length === 1024)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))

  const clusters: RawCluster[] = []

  for (const event of sorted) {
    const vector = event.embedding!
    let bestIdx = -1
    let bestSim = SIMILARITY_FLOOR // 低于门槛不归类
    for (let i = 0; i < clusters.length; i++) {
      const sim = cosineSimilarity(vector, clusters[i].centroid)
      if (sim >= bestSim) {
        bestSim = sim
        bestIdx = i
      }
    }

    if (bestIdx >= 0) {
      const c = clusters[bestIdx]
      c.members.push(event)
      if (event.occurredAt > c.lastSeenAt) c.lastSeenAt = event.occurredAt
      if (event.occurredAt < c.firstSeenAt) c.firstSeenAt = event.occurredAt
      c.centroid = recomputeCentroid(c.members, now)
    } else {
      clusters.push({
        members: [event],
        centroid: [...vector],
        firstSeenAt: event.occurredAt,
        lastSeenAt: event.occurredAt,
      })
    }
  }

  return clusters
}

/** 加权质心重算（成员变动后调用；百级事件量级成本可忽略，换确定性） */
function recomputeCentroid(members: EngineEvent[], now: Date): number[] {
  return weightedCentroid(
    members
      .filter((m) => Array.isArray(m.embedding))
      .map((m) => ({ vector: m.embedding!, weight: Math.max(0, effectiveWeight(m, now)) }))
  )
}
