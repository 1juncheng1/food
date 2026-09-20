// ============================================================
// Creator Interest Profile —— 事件有效权重原语（纯函数）
// 从 scoring 拆出，供 clustering（加权质心）共用，避免模块循环依赖。
//
// w(e) = baseWeight × reasonFactor × 0.5^(ageDays/45)
// ============================================================

import {
  EVENT_REGISTRY,
  HALF_LIFE_DAYS,
  REASON_FACTORS,
  REASON_FACTOR_UNKNOWN,
} from './config'
import type {
  CreatorEventType,
  EngineEvent,
  ReasonCode,
  ReasonInterpretation,
} from './types'

const MS_PER_DAY = 86_400_000

export function ageDays(occurredAt: string, now: Date): number {
  const t = Date.parse(occurredAt)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, (now.getTime() - t) / MS_PER_DAY)
}

/** 时间衰减：半衰期 45 天 */
export function recencyWeight(days: number, halfLifeDays: number = HALF_LIFE_DAYS): number {
  return Math.pow(0.5, days / halfLifeDays)
}

/**
 * 原因折扣 = Σ 概率 × 系数。
 * 未解释/解释结构缺失 → 1.0（按真实兴趣处理，代价体现在置信度而非分数上）。
 */
export function reasonFactor(
  interpretation: ReasonInterpretation | null | undefined
): number {
  if (!interpretation || !Array.isArray(interpretation.reasons) || interpretation.reasons.length === 0) {
    return 1
  }
  let factor = 0
  for (const r of interpretation.reasons) {
    const p = Number(r.probability)
    if (!Number.isFinite(p) || p <= 0) continue
    const code = r.code as ReasonCode
    factor += p * (REASON_FACTORS[code] ?? REASON_FACTOR_UNKNOWN)
  }
  return factor > 0 ? Math.min(1, factor) : 1
}

/**
 * 真实兴趣占比（core 分层门槛 genuine+research ≥ 0.6 用）。
 * 未解释事件视为 1.0 genuine；已解释按 genuine+research 概率和。
 */
export function genuineShare(
  interpretation: ReasonInterpretation | null | undefined
): number {
  if (!interpretation || !Array.isArray(interpretation.reasons) || interpretation.reasons.length === 0) {
    return 1
  }
  let share = 0
  for (const r of interpretation.reasons) {
    const p = Number(r.probability)
    if (!Number.isFinite(p) || p <= 0) continue
    if (r.code === 'genuine_interest' || r.code === 'narrative_research') share += p
  }
  return Math.min(1, share)
}

/** 单事件有效权重（含符号；stats_only/撤回类为 0） */
export function effectiveWeight(event: EngineEvent, now: Date): number {
  const reg = EVENT_REGISTRY[event.type]
  if (!reg || reg.effect === 'stats_only' || reg.effect === 'withdraw') return 0
  const base = reg.weight
  if (base === 0) return 0
  return base * reasonFactor(event.interpretation) * recencyWeight(ageDays(event.occurredAt, now))
}

/** 该事件类型是否需要 AI 原因解释（置信度覆盖率分母用） */
export function needsInterpret(type: CreatorEventType): boolean {
  return EVENT_REGISTRY[type]?.interpret === 'yes'
}
