// ============================================================
// Creator Interest Profile —— 簇置信度（纯函数）
//
// confidence = 0.35×项目数 + 0.25×事件量 + 0.20×解释覆盖率
//            + 0.10×新鲜度 + 0.10×项目离散度
// 去重项目 <2 时硬上限 0.4：单次孤立行为不允许高置信（电影测试的防线）。
// ============================================================

import {
  CONFIDENCE_EVENT_FULL,
  CONFIDENCE_FRESH_WINDOW_DAYS,
  CONFIDENCE_LOW_PROJECT_CAP,
  CONFIDENCE_PROJECT_FULL,
  CONFIDENCE_WEIGHTS,
} from './config'
import type { EngineEvent } from './types'
import { ageDays, effectiveWeight } from './weights'

export interface ConfidenceInput {
  projectCount: number
  members: EngineEvent[]
  now: Date
}

/**
 * @param interpretableCount 需解释事件数（registry.interpret==='yes'）
 * @param interpretedCount   其中已完成解释（interpretation 非空）的数量
 */
export function clusterConfidence(
  input: ConfidenceInput,
  interpretableCount: number,
  interpretedCount: number
): number {
  const { projectCount, members, now } = input
  const positive = members.filter((e) => effectiveWeight(e, now) > 0)
  const eventCount = positive.length

  const projectTerm = Math.min(1, projectCount / CONFIDENCE_PROJECT_FULL)
  const eventTerm = Math.min(1, eventCount / CONFIDENCE_EVENT_FULL)
  const coverage = interpretableCount > 0 ? interpretedCount / interpretableCount : 1
  const freshCount = positive.filter((e) => ageDays(e.occurredAt, now) <= CONFIDENCE_FRESH_WINDOW_DAYS).length
  const freshness = eventCount > 0 ? freshCount / eventCount : 0
  // 离散度：去重项目（含独立 target）/ 事件数；一项目多版本被稀释
  const units = new Set(
    positive.map((e) => (e.projectId ? `p:${e.projectId}` : `t:${e.targetId ?? e.id}`))
  ).size
  const spread = eventCount > 0 ? Math.min(1, units / eventCount) : 0

  let score =
    CONFIDENCE_WEIGHTS.project * projectTerm +
    CONFIDENCE_WEIGHTS.event * eventTerm +
    CONFIDENCE_WEIGHTS.interpretCoverage * coverage +
    CONFIDENCE_WEIGHTS.freshness * freshness +
    CONFIDENCE_WEIGHTS.spread * spread

  if (projectCount < 2) score = Math.min(score, CONFIDENCE_LOW_PROJECT_CAP)
  return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000
}
