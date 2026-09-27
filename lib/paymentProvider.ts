// ============================================================
// lib/paymentProvider —— 支付层抽象（需求 §18）
//
// 这一层只有一个目的：**把"钱是怎么进来的"与"积分是怎么记的"分开**。
//
// 现在的现实是：没有微信/支付宝商户能力，只能"用户扫码 → 用户声称已付
// → 管理员人工核账 → 才加积分"。这套逻辑如果被直接写进订单状态机里，
// 将来接正式支付回调时就要把订单、账本、余额全翻一遍——那是重写，不是接入。
//
// 所以这里把支付通道收敛成一个接口：
//   · autoConfirm=false 的通道（MANUAL）    → 必须由管理员确认才产生积分
//   · autoConfirm=true  的通道（将来 WECHAT/ALIPAY）→ 官方回调即可自动确认
// 两种通道共用同一套 RechargeOrder / PointLedger / user_balances，
// 差别只在"谁来按下确认这个按钮"。
//
// 刻意不做的事（需求 §6 明令禁止）：
//   不抓取个人微信/支付宝账单、不自动登录支付账户、不监听收款通知。
// MANUAL 通道下系统**从不认为自己知道钱到了**，它只知道"用户说付了"。
// ============================================================

/** 支付通道标识（与 recharge_orders.provider 的 check 约束同步） */
export type PaymentProviderId = 'MANUAL'

export interface PaymentProvider {
  id: PaymentProviderId
  /** 展示给用户的通道名 */
  label: string
  /**
   * 该通道能否由系统自动确认到账。
   * false ⇒ 必须经管理员人工确认才会产生积分（需求 §1：只有管理员确认后才能充值）
   */
  autoConfirm: boolean
  /** 用户点「我已完成支付」之后，系统允许说的话（绝不能说"支付成功"） */
  submittedMessage: string
  /** 管理员确认到账之后对用户的话术 */
  confirmedMessage: string
}

/**
 * 人工收款通道（MVP 唯一实现）。
 *
 * 话术纪律写在需求 §15：管理员确认前，系统不能说"支付成功"——
 * 因为系统**真的不知道**钱有没有到，它只收到了用户的一面之词。
 */
export const ManualPaymentProvider: PaymentProvider = {
  id: 'MANUAL',
  label: '扫码付款',
  autoConfirm: false,
  submittedMessage: '已提交支付确认，请等待管理员确认到账。确认后积分会自动到账。',
  confirmedMessage: '充值成功，积分已到账',
}

const PROVIDERS: Record<PaymentProviderId, PaymentProvider> = {
  MANUAL: ManualPaymentProvider,
}

/**
 * 取支付通道实现。
 *
 * 未知标识一律回落到 MANUAL —— 这是**保守方向**：宁可走人工确认，
 * 也不能因为一个不认识的 provider 值就跳过核账直接加积分。
 */
export function getPaymentProvider(id: string | null | undefined): PaymentProvider {
  if (id && id in PROVIDERS) return PROVIDERS[id as PaymentProviderId]
  return ManualPaymentProvider
}

/** 该通道是否需要管理员人工确认（路由层判定"能不能自动到账"的唯一出处） */
export function requiresManualConfirmation(id: string | null | undefined): boolean {
  return !getPaymentProvider(id).autoConfirm
}
