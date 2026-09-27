// ============================================================
// DeclarationLearning —— 创作者声明的持续学习
//
// 设计原则：
//   1. declaration（用户主动声明）是权威边界，行为信号只做软修正
//   2. 只在用户长期一致地表现相反偏好时才覆盖 declaration
//   3. 单次行为不更新，需要累积证据（默认 3 次以上同向行为）
//   4. avoid_preference 是硬约束，行为信号不能轻易解除
//   5. 学习是异步的，不阻塞生成主流程
//
// 信号来源：
//   - Work Agent 反馈：用户反复选"增强案例"→ thinking_profile 倾向案例
//   - 编辑行为：用户反复删除情绪化内容→ emotional_preference 倾向理性
//   - 作品定稿：用户反复定稿深度内容→ quality_standard 倾向知识
//   - 删除作品：用户反复删除口水化作品→ avoid_preference 增加"空洞鸡汤"
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  normalizeCreatorDeclaration,
  isDeclarationEmpty,
  type CreatorDeclaration,
  type DeclarationDimension,
} from './creatorDeclaration'

// ── 1. 行为信号类型 ───────────────────────────────────────

/**
 * 用户行为信号。
 * 每个信号代表一次用户表达偏好的行为。
 */
export interface BehaviorSignal {
  /** 信号类型 */
  type:
    | 'work_feedback' // Work Agent 反馈
    | 'edit_pattern' // 编辑行为
    | 'finalize_choice' // 定稿选择
    | 'delete_work' // 删除作品
    | 'direction_choice' // 选择优化方向
  /** 推断的维度 */
  dimension: DeclarationDimension
  /** 推断的值 */
  inferredValue: string
  /** 信号强度（1-5，默认 1） */
  strength?: number
  /** 信号时间戳（ISO） */
  at?: string
}

// ── 2. 行为信号累积器 ─────────────────────────────────────

/**
 * 累积行为信号，按 (dimension, value) 聚合计数。
 * 用于判断某项行为是否达到"长期一致"的阈值。
 */
export interface SignalAccumulator {
  /** key: `${dimension}:${value}` */
  counts: Record<string, number>
  /** 总信号数 */
  total: number
}

export function createSignalAccumulator(): SignalAccumulator {
  return { counts: {}, total: 0 }
}

export function addSignal(
  acc: SignalAccumulator,
  signal: BehaviorSignal
): SignalAccumulator {
  const key = `${signal.dimension}:${signal.inferredValue}`
  const strength = Math.max(1, Math.min(5, signal.strength ?? 1))
  return {
    counts: {
      ...acc.counts,
      [key]: (acc.counts[key] ?? 0) + strength,
    },
    total: acc.total + strength,
  }
}

// ── 3. 阈值配置 ───────────────────────────────────────────

/** 修正 declaration 需要的最低累积强度（避免单次行为影响） */
export const CORRECTION_THRESHOLD = 3

/** 覆盖 declaration（用户主动声明）需要的更高强度 */
export const OVERRIDE_THRESHOLD = 5

// ── 4. 软更新函数 ─────────────────────────────────────────

export interface DeclarationUpdateResult {
  /** 更新后的 declaration */
  declaration: CreatorDeclaration
  /** 本次是否实际修改了 declaration */
  changed: boolean
  /** 修改了哪些维度 */
  changes: Array<{
    dimension: DeclarationDimension
    oldValue: string | undefined
    newValue: string
    reason: string
  }>
}

/**
 * 根据累积的行为信号软更新 declaration。
 *
 * 更新规则：
 *   1. 如果某维度在 declaration 中为空（未访谈或未回答）：
 *      - 累积强度 ≥ CORRECTION_THRESHOLD（3）→ 填充该维度
 *   2. 如果某维度已有值（用户已声明）：
 *      - 累积强度 ≥ OVERRIDE_THRESHOLD（5）且行为值不同 → 覆盖
 *      - 累积强度 < OVERRIDE_THRESHOLD → 不动（尊重用户声明）
 *   3. avoid_preference 是硬约束：只允许新增，不允许覆盖
 *      - 用户反复删除某类内容 → 新增到 avoid_preference（去重）
 *
 * @param declaration 当前 declaration（已 normalize）
 * @param acc 累积信号
 * @returns 更新结果
 */
export function updateDeclarationFromBehavior(
  declaration: CreatorDeclaration,
  acc: SignalAccumulator
): DeclarationUpdateResult {
  const changes: DeclarationUpdateResult['changes'] = []
  const updated: CreatorDeclaration = { ...declaration }

  // 按维度聚合信号
  const byDimension: Record<string, Array<{ value: string; strength: number }>> = {}
  for (const [key, strength] of Object.entries(acc.counts)) {
    const [dim, value] = key.split(':')
    if (!dim || !value) continue
    if (!byDimension[dim]) byDimension[dim] = []
    byDimension[dim].push({ value, strength })
  }

  for (const [dim, signals] of Object.entries(byDimension)) {
    const dimension = dim as DeclarationDimension
    // 找出该维度最强的行为值
    const sorted = [...signals].sort((a, b) => b.strength - a.strength)
    const topSignal = sorted[0]
    if (!topSignal) continue

    const currentValue = updated[dimension] as string | undefined

    // avoid_preference 特殊处理：只允许新增，不允许覆盖
    if (dimension === 'avoid_preference') {
      if (currentValue && currentValue.includes(topSignal.value)) continue
      // 新增到 avoid_preference（用「、」分隔）
      const newValue = currentValue
        ? `${currentValue}、${topSignal.value}`
        : topSignal.value
      if (topSignal.strength >= CORRECTION_THRESHOLD) {
        ;(updated as Record<string, unknown>)[dimension] = newValue
        changes.push({
          dimension,
          oldValue: currentValue,
          newValue,
          reason: `用户反复删除/反馈此类内容 ${topSignal.strength} 次，新增为硬禁忌`,
        })
      }
      continue
    }

    // 其他维度：空值填充 or 高强度覆盖
    if (!currentValue) {
      // declaration 中为空：累积强度 ≥ 3 即填充
      if (topSignal.strength >= CORRECTION_THRESHOLD) {
        ;(updated as Record<string, unknown>)[dimension] = topSignal.value
        changes.push({
          dimension,
          oldValue: undefined,
          newValue: topSignal.value,
          reason: `declaration 未填写，行为累积 ${topSignal.strength} 次，填充`,
        })
      }
    } else if (currentValue !== topSignal.value) {
      // declaration 已有值且不同：累积强度 ≥ 5 才覆盖
      if (topSignal.strength >= OVERRIDE_THRESHOLD) {
        ;(updated as Record<string, unknown>)[dimension] = topSignal.value
        changes.push({
          dimension,
          oldValue: currentValue,
          newValue: topSignal.value,
          reason: `用户长期行为 ${topSignal.strength} 次表现与此维度声明不同，覆盖声明`,
        })
      }
    }
  }

  // 更新元数据
  if (changes.length > 0) {
    updated.source = 'ai_update'
    updated.interviewedAt = updated.interviewedAt ?? new Date().toISOString()
  }

  return {
    declaration: updated,
    changed: changes.length > 0,
    changes,
  }
}

// ── 5. 服务端持久化函数 ───────────────────────────────────

/**
 * 服务端调用：从 style_profiles 读取 declaration，
 * 应用行为信号软更新，写回 style_profiles。
 *
 * 失败静默，不阻断生成主流程。
 */
export async function persistDeclarationUpdate(
  supabase: SupabaseClient,
  userId: string,
  acc: SignalAccumulator
): Promise<DeclarationUpdateResult | null> {
  try {
    // 读现有 declaration
    const { data: profile, error: readErr } = await supabase
      .from('style_profiles')
      .select('creator_declaration')
      .eq('user_id', userId)
      .maybeSingle()

    if (readErr) {
      console.error('declarationLearning 读失败:', readErr.message)
      return null
    }

    const current = normalizeCreatorDeclaration(
      (profile as Record<string, unknown> | null)?.creator_declaration
    )

    // 应用软更新
    const result = updateDeclarationFromBehavior(current, acc)
    if (!result.changed) return result

    // 写回
    const { error: writeErr } = await supabase
      .from('style_profiles')
      .upsert(
        {
          user_id: userId,
          creator_declaration: result.declaration,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      )

    if (writeErr) {
      console.error('declarationLearning 写失败:', writeErr.message)
      return null
    }

    return result
  } catch (e) {
    console.error('declarationLearning 异常:', e)
    return null
  }
}
