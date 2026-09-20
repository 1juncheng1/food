// ============================================================
// WF0：推荐接口降级原因码（机器可观测，取代 catch-all 静默伪装）
//
// 背景：旧版任何异常都返回同一份"平台推荐选题"模板，运维无法区分
// 游客 / 登录失效 / 冷启动 / 空队列 / 内部错误（D1-D3 不可诊断）。
// ============================================================

import { describe, expect, it } from 'vitest'
import { resolveDegradeReason } from './degrade'

describe('resolveDegradeReason', () => {
  it('无 token 时判定为 guest（游客路径，即使其他状态全空）', () => {
    expect(resolveDegradeReason({ hasToken: false, userResolved: false, hasProfile: false, suggestionCount: 0 })).toBe('guest')
  })

  it('带 token 但 getUser 失败/无用户时判定为 auth_expired', () => {
    expect(resolveDegradeReason({ hasToken: true, userResolved: false, hasProfile: false, suggestionCount: 0 })).toBe('auth_expired')
  })

  it('登录正常但画像尚未构建时判定为 cold_start', () => {
    expect(resolveDegradeReason({ hasToken: true, userResolved: true, hasProfile: false, suggestionCount: 0 })).toBe('cold_start')
  })

  it('画像存在但 active 队列为空时判定为 empty_queue（不与 cold_start 混淆）', () => {
    expect(resolveDegradeReason({ hasToken: true, userResolved: true, hasProfile: true, suggestionCount: 0 })).toBe('empty_queue')
  })

  it('画像存在且队列有卡时返回 null（个性化正常，不降级）', () => {
    expect(resolveDegradeReason({ hasToken: true, userResolved: true, hasProfile: true, suggestionCount: 3 })).toBeNull()
  })

  it('捕获到异常时判定为 error，优先级高于其他状态', () => {
    expect(resolveDegradeReason({ hasToken: true, userResolved: true, hasProfile: true, suggestionCount: 3, caughtError: true })).toBe('error')
  })

  it('无 token + 异常同时存在时仍报 error（异常必须可见，不被游客态掩盖）', () => {
    expect(resolveDegradeReason({ hasToken: false, userResolved: false, hasProfile: false, suggestionCount: 0, caughtError: true })).toBe('error')
  })
})
