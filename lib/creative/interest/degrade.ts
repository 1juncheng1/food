// ============================================================
// WF0：推荐接口降级原因码（纯函数，无 IO 依赖，可单测）
//
// 旧版 GET /api/inspirations 的所有失败路径都返回同一份模板且无标记，
// D1（游客/失效会话）/D2（异常）/D3（冷启动）/空队列在用户侧完全不可区分。
// 响应中的 degrade_reason 只做机器可观测诊断，不向用户暴露技术细节。
// ============================================================

export type DegradeReason = 'guest' | 'auth_expired' | 'cold_start' | 'empty_queue' | 'error'

export interface DegradeInput {
  /** 请求是否携带 Authorization Bearer token */
  hasToken: boolean
  /** token 通过 getUser 校验且取到用户 */
  userResolved: boolean
  /** style_profiles.interest_profile 存在且带 build_id */
  hasProfile: boolean
  /** interest_suggestions active 卡数量 */
  suggestionCount: number
  /** 是否在 catch 异常分支（优先级最高，异常绝不允许被伪装成正常降级） */
  caughtError?: boolean
}

/**
 * 判定本次请求为何降级；返回 null 表示个性化链路正常、不应降级。
 */
export function resolveDegradeReason(input: DegradeInput): DegradeReason | null {
  if (input.caughtError) return 'error'
  if (!input.hasToken) return 'guest'
  if (!input.userResolved) return 'auth_expired'
  if (!input.hasProfile) return 'cold_start'
  if (input.suggestionCount === 0) return 'empty_queue'
  return null
}
