// ============================================================
// InterviewTrigger —— 访谈触发逻辑
//
// 判断是否需要触发首次访谈，决定何时弹出访谈 UI。
// 复用 normalizeCreatorDeclaration 和 isDeclarationComplete，
// 不直接调 LLM，不读库。
// ============================================================

import {
  normalizeCreatorDeclaration,
  isDeclarationEmpty,
  isDeclarationComplete,
  type CreatorDeclaration,
} from './creatorDeclaration'
import { CURRENT_INTERVIEW_VERSION } from './interviewQuestions'

// ── 触发判断 ───────────────────────────────────────────────

export interface InterviewTriggerResult {
  /** 是否需要触发访谈 */
  shouldTrigger: boolean
  /** 触发原因（UI 展示给用户） */
  reason?: string
  /** 触发类型：首次 / 未完成 / 版本过期 */
  triggerType?: 'first_time' | 'incomplete' | 'version_outdated'
}

/**
 * 判断是否需要触发访谈。
 *
 * 触发条件（满足任一即触发）：
 *   1. declaration 为空（首次用户）
 *   2. declaration 未完成（回答数 < 6，中途退出）
 *   3. declaration 版本号过期（问题集更新后需要重新访谈）
 *
 * 不触发的情况：
 *   - declaration 完整且版本号匹配 → 已访谈用户
 *
 * @param rawDeclaration 从 style_profiles.creator_declaration 读出的原始数据
 * @returns 触发判断结果
 */
export function shouldTriggerInterview(
  rawDeclaration: unknown
): InterviewTriggerResult {
  const declaration: CreatorDeclaration = normalizeCreatorDeclaration(
    rawDeclaration
  )

  // 1. 空声明 → 首次访谈
  if (isDeclarationEmpty(declaration)) {
    return {
      shouldTrigger: true,
      reason: 'AI 想先认识你一下，只需 1 分钟',
      triggerType: 'first_time',
    }
  }

  // 2. 未完成 → 继续未完成的访谈
  if (!isDeclarationComplete(declaration)) {
    return {
      shouldTrigger: true,
      reason: '你的创作偏好还没填完，继续完成让 AI 更懂你',
      triggerType: 'incomplete',
    }
  }

  // 3. 版本过期 → 重新访谈（未来问题集调整时触发）
  if (
    declaration.interviewVersion &&
    declaration.interviewVersion < CURRENT_INTERVIEW_VERSION
  ) {
    return {
      shouldTrigger: true,
      reason: '问题集已更新，重新访谈让 AI 更准确理解你',
      triggerType: 'version_outdated',
    }
  }

  // 4. 完整 + 版本号匹配 → 不触发
  return { shouldTrigger: false }
}

// ── 触发时机的最小间隔保护 ─────────────────────────────────

const MIN_INTERVAL_BETWEEN_PROMPTS = 1000 * 60 * 60 * 24 * 7 // 7 天

/**
 * 判断是否到了可以再次提醒用户访谈的时间。
 * 用于"用户跳过访谈后，多久后可以再提醒"的场景。
 *
 * @param lastDismissedAt 用户上次关闭访谈弹窗的时间戳（ms）
 * @returns 是否可以再次提醒
 */
export function canRepromptInterview(lastDismissedAt: number | null): boolean {
  if (!lastDismissedAt) return true
  return Date.now() - lastDismissedAt > MIN_INTERVAL_BETWEEN_PROMPTS
}
