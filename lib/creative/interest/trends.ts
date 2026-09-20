// ============================================================
// Creator Interest Profile —— 趋势计算（纯函数）
//
// 窗口分 d7/d30/d90/d365 = 簇成员在各窗口内有效权重之和（不再二次封顶；
// 项目封顶只作用于最终 rawScore，窗口分是"活跃度指示"而非兴趣强度）。
// slope = 本期 d30 与上期 d30 的归一化差异；方向带阈值，避免噪声抖动。
// ============================================================

import { TRENDS_EWMA_ALPHA, TREND_SLOPE_DECLINING, TREND_SLOPE_RISING } from './config'
import type { EngineEvent, TrendDirection } from './types'
import { ageDays, effectiveWeight } from './weights'

export interface WindowScores {
  d7: number
  d30: number
  d90: number
  d365: number
}

const WINDOWS: Array<[keyof WindowScores, number]> = [
  ['d7', 7],
  ['d30', 30],
  ['d90', 90],
  ['d365', 365],
]

/** 各时间窗有效权重之和（负事件不参与，趋势只看正向活跃） */
export function windowScores(members: EngineEvent[], now: Date): WindowScores {
  const out: WindowScores = { d7: 0, d30: 0, d90: 0, d365: 0 }
  for (const e of members) {
    const w = effectiveWeight(e, now)
    if (w <= 0) continue
    const age = ageDays(e.occurredAt, now)
    for (const [key, days] of WINDOWS) {
      if (age <= days) out[key] += w
    }
  }
  return out
}

/** 归一化斜率：(cur-prev)/max(|cur|,|prev|,ε)，范围 [-1,1] */
export function slope(cur: number, prev: number | null): number {
  if (prev === null) return 0
  const denom = Math.max(Math.abs(cur), Math.abs(prev), 1e-6)
  return Math.max(-1, Math.min(1, (cur - prev) / denom))
}

/**
 * 趋势方向：
 *   dormant   —— 近 7 天零贡献（沉睡，不再用于核心推荐槽）
 *   rising    —— slope > 0.1
 *   declining —— slope < -0.1
 *   stable    —— 其余
 * 无上期数据（prev=null）时，除 dormant 外一律 stable（不凭单期数据判升降）。
 */
export function trendDirection(w: WindowScores, prevD30: number | null): TrendDirection {
  if (w.d7 === 0) return 'dormant'
  if (prevD30 === null) return 'stable'
  const s = slope(w.d30, prevD30)
  if (s > TREND_SLOPE_RISING) return 'rising'
  if (s < TREND_SLOPE_DECLINING) return 'declining'
  return 'stable'
}

/** EWMA 平滑：首期直接取本期值 */
export function ewma(prev: number | null, cur: number, alpha: number = TRENDS_EWMA_ALPHA): number {
  if (prev === null) return cur
  return alpha * cur + (1 - alpha) * prev
}
