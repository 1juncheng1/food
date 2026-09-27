// ============================================================
// lib/paymentProvider —— 支付通道契约（需求 §18）
//
// 锁住两件事：
//   ① MANUAL 通道**绝不自动加积分**（autoConfirm=false 是硬约束）
//   ② 未知/缺失的通道标识一律回落 MANUAL —— 保守方向：宁可走人工确认，
//      也不能因为一个不认识的值就跳过核账直接给用户加分
//
// 另外把需求 §15 的措辞纪律写成断言：管理员确认前，系统不许说"支付成功"。
// ============================================================

import { describe, expect, it } from 'vitest'
import {
  ManualPaymentProvider,
  getPaymentProvider,
  requiresManualConfirmation,
} from './paymentProvider'

describe('ManualPaymentProvider：人工收款通道', () => {
  it('必须管理员人工确认才产生积分', () => {
    expect(ManualPaymentProvider.autoConfirm).toBe(false)
  })

  it('需求 §15：已提交文案不得出现「支付成功」（系统此时并不知道钱到了）', () => {
    expect(ManualPaymentProvider.submittedMessage).not.toContain('支付成功')
    expect(ManualPaymentProvider.submittedMessage).not.toContain('充值成功')
  })

  it('已提交文案如实说明要等管理员确认', () => {
    expect(ManualPaymentProvider.submittedMessage).toContain('等待管理员确认')
  })

  it('确认后的文案才说「充值成功」', () => {
    expect(ManualPaymentProvider.confirmedMessage).toContain('充值成功')
  })
})

describe('getPaymentProvider：通道解析', () => {
  it('MANUAL → 人工收款通道', () => {
    expect(getPaymentProvider('MANUAL').id).toBe('MANUAL')
  })

  it('未知通道值 → 回落 MANUAL（保守方向）', () => {
    expect(getPaymentProvider('WECHAT').id).toBe('MANUAL')
    expect(getPaymentProvider('ALIPAY').id).toBe('MANUAL')
  })

  it('null / undefined / 空串 → 回落 MANUAL', () => {
    expect(getPaymentProvider(null).id).toBe('MANUAL')
    expect(getPaymentProvider(undefined).id).toBe('MANUAL')
    expect(getPaymentProvider('').id).toBe('MANUAL')
  })
})

describe('requiresManualConfirmation：是否需要人工核账', () => {
  it('MVP 阶段任何通道都需要人工确认', () => {
    expect(requiresManualConfirmation('MANUAL')).toBe(true)
    expect(requiresManualConfirmation('WECHAT')).toBe(true)
    expect(requiresManualConfirmation(null)).toBe(true)
  })
})
