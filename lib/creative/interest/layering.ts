// ============================================================
// Creator Interest Profile —— 确定性分层（纯函数）
//
// LLM 不参与分层：core / exploration / temporary 只由可复算规则推导。
//   temporary  —— 观察期 ≤14 天；或 ≥90% 事件集中在连续 7 天突发窗
//   exploration —— 活跃但未达 core 门槛；temporary 满 21 天且 ≥2 项目后升
//   core       —— 年龄≥30 天 + weight≥0.55 + genuine 占比≥0.6
//                  + (去重项目≥3 或 事件≥5)
// 降层迟滞：core 连续 2 期 build 不达标才降级，防止层间来回抖动。
// ============================================================

import {
  CORE_MIN_AGE_DAYS,
  CORE_MIN_EVENTS,
  CORE_MIN_GENUINE_RATIO,
  CORE_MIN_PROJECTS,
  CORE_MIN_WEIGHT,
  DOWNGRADE_STREAK,
  EXPLORATION_PROMOTE_DAYS,
  TEMPORARY_BURST_DAYS,
  TEMPORARY_GRACE_DAYS,
} from './config'
import type { InterestLayer } from './types'

export interface LayerClusterInput {
  ageDays: number
  projectCount: number
  eventCount: number
  weight: number
  genuineRatio: number
  /** 突发检测结果（detectBurst 输出），builder 预计算传入 */
  burst: boolean
}

export interface PreviousLayerState {
  layer: InterestLayer
  /** 截至上一期连续不达标次数 */
  downgradeStreak: number
}

export interface LayerDecision {
  layer: InterestLayer
  /** 截至本期连续不达标次数（builder 落库供下期使用） */
  downgradeStreak: number
  changed: boolean
}

/**
 * 突发检测：是否存在一个连续 windowDays 窗口容纳 ≥90% 的事件。
 * 典型场景：一天内测试电影解说功能连生成 3 版。
 */
export function detectBurst(occurredAts: string[], windowDays: number = TEMPORARY_BURST_DAYS): boolean {
  if (occurredAts.length < 2) return false
  const times = occurredAts.map((s) => Date.parse(s)).filter(Number.isFinite).sort((a, b) => a - b)
  if (times.length < 2) return false
  const windowMs = windowDays * 86_400_000
  let maxInWindow = 1
  let left = 0
  for (let right = 0; right < times.length; right++) {
    while (times[right] - times[left] > windowMs) left++
    maxInWindow = Math.max(maxInWindow, right - left + 1)
  }
  return maxInWindow / times.length >= 0.9
}

function meetsCoreBar(c: LayerClusterInput): boolean {
  return (
    c.ageDays >= CORE_MIN_AGE_DAYS &&
    c.weight >= CORE_MIN_WEIGHT &&
    c.genuineRatio >= CORE_MIN_GENUINE_RATIO &&
    (c.projectCount >= CORE_MIN_PROJECTS || c.eventCount >= CORE_MIN_EVENTS)
  )
}

/**
 * 无历史的新簇首判（或 full rebuild 无上期状态时）。
 */
export function initialLayer(c: LayerClusterInput): InterestLayer {
  if (c.burst) return 'temporary'
  if (c.ageDays <= TEMPORARY_GRACE_DAYS) return 'temporary'
  if (meetsCoreBar(c)) return 'core'
  return 'exploration'
}

/**
 * 跨 build 分层决策（含升降级与迟滞）。纯函数，上期状态显式传入。
 */
export function decideLayer(
  c: LayerClusterInput,
  previous: PreviousLayerState | null
): LayerDecision {
  if (!previous) {
    const layer = initialLayer(c)
    return { layer, downgradeStreak: 0, changed: false }
  }

  // 计算"无迟滞理想层"
  let target: InterestLayer
  if (c.burst) {
    target = 'temporary'
  } else if (meetsCoreBar(c)) {
    target = 'core'
  } else if (previous.layer === 'temporary') {
    target =
      c.ageDays >= EXPLORATION_PROMOTE_DAYS && c.projectCount >= 2 ? 'exploration' : 'temporary'
  } else {
    target = 'exploration'
  }

  // 升级即时生效；core 降级需要连续 DOWNGRADE_STREAK 期不达标
  if (previous.layer === 'core' && target !== 'core') {
    const streak = previous.downgradeStreak + 1
    if (streak >= DOWNGRADE_STREAK) {
      return { layer: target, downgradeStreak: 0, changed: true }
    }
    return { layer: 'core', downgradeStreak: streak, changed: false }
  }

  return {
    layer: target,
    downgradeStreak: 0,
    changed: target !== previous.layer,
  }
}
