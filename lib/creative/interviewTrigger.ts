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
  missingIdentityDimensions,
  type CreatorDeclaration,
  type DeclarationDimension,
} from './creatorDeclaration'
import { CURRENT_INTERVIEW_VERSION } from './interviewQuestions'

// ── 触发判断 ───────────────────────────────────────────────

export interface InterviewTriggerResult {
  /** 是否需要触发访谈 */
  shouldTrigger: boolean
  /** 触发原因（UI 展示给用户） */
  reason?: string
  /** 触发类型：首次 / 未完成 / 增量补问 / 版本过期 */
  triggerType?: 'first_time' | 'incomplete' | 'supplement' | 'version_outdated'
  /**
   * 增量补问时需要补的维度（仅 triggerType='supplement' 有值）。
   * 调用方把它传给 /api/creative/interview 只取这几问的问题，
   * 避免"新增 3 个问题就要求老用户重答 13 问"。
   */
  missingDimensions?: DeclarationDimension[]
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

  // 3. 增量补问：核心维度已完整，但「我是谁」三问还没答。
  //    这三问是后来加的（2026-09-24），老用户没有这些数据却不该被当成"未访谈"，
  //    更不该被要求重答全部问题 —— 只补缺的那几问，成本最低、抵触最小。
  //    刻意放在版本过期判断之前：补齐缺口优先于全量重访。
  const missingIdentity = missingIdentityDimensions(declaration)
  if (missingIdentity.length > 0) {
    return {
      shouldTrigger: true,
      reason:
        '再补 3 个问题，让 AI 知道你是谁、坚持什么、要去哪里',
      triggerType: 'supplement',
      missingDimensions: missingIdentity,
    }
  }

  // 4. 版本过期 → 重新访谈（未来问题集调整时触发）
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

  // 5. 完整 + 版本号匹配 → 不触发
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
