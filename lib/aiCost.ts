// ============================================================
// lib/aiCost —— AI 消费计费（Phase 4）
//
// 需求 §17-19 的三条硬约束，落在这里：
//
//   ① **调用前检查**：余额不够本次预计消费，绝不发起 LLM 请求。
//      先调 API 再发现没钱，成本就是平台自己承担的（§18 明令禁止）。
//   ② **按实际消耗计费**：调用完按真实 token 用量算，不是按次数一口价。
//   ③ **并发安全**：预扣走行锁原子扣减，两个并发请求不可能都"看到"
//      同一份余额，也就不会出现余额 100 被两笔各扣 50 之后的账实不符。
//
// 因此采用「**预扣 + 结算**」两阶段，而不是"先检查、后扣费"：
//
//   预扣 reserve → 按 AI_PRECHARGE_* 扣一个保守的上限
//     ↓ 发起 LLM 调用
//   结算 settle  → 实际 < 预扣：差额原路退回（REFUND 流水）
//                  实际 > 预扣：补扣差额（AI_CONSUMPTION 流水）
//                  调用失败    ：全额退回
//
// 为什么不用"先检查后扣"：检查与扣费之间隔着一次网络往返（几十毫秒到几十秒），
// 并发请求会同时通过检查，最后两笔都扣不动 → 白嫖且账目对不上。
// 预扣把"扣"提前到"检查"的同一时刻，原子完成，这个窗口就不存在了。
//
// 所有价格来自 point_config（AI_PRECHARGE_* / POINTS_PER_YUAN），
// 这个文件里没有任何写死的价格。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { chargePointsForUsage, ZERO_USAGE, type TokenUsage } from '@/lib/balance'
import {
  consumePoints,
  getPointConfig,
  refundPoints,
  type PointConfig,
} from '@/lib/points'

/** 可计费的 AI 能力（与 PointConfig.precharge 的键一一对应） */
export type AiAbility = keyof PointConfig['precharge']

export type AiReserveResult =
  | { ok: true; reserved: number; balance: number; duplicated: boolean }
  | { ok: false; code: 'insufficient_balance' | 'error'; required: number; balance?: number }

/** 取某能力的调用前预扣额度（读配置，读不到回落到兜底快照） */
export async function prechargeFor(
  supabase: SupabaseClient,
  ability: AiAbility
): Promise<number> {
  const cfg = await getPointConfig(supabase)
  const v = cfg.precharge[ability]
  return Number.isFinite(v) && v > 0 ? v : cfg.minGenerationCost
}

/**
 * 余额是否够某能力的最低消费（**只检查，不扣费**）。
 *
 * 用途：路由层在调用前给用户一句准确的「请充值」，而不是含糊的「生成失败」。
 * 它**不能替代** reserveAiCost——真正的并发安全由预扣那一刀保证，
 * 这里只是提前把话说清楚（fail-open：读不到余额时放行）。
 */
export async function hasEnoughFor(
  supabase: SupabaseClient,
  userId: string,
  ability: AiAbility
): Promise<{ ok: boolean; required: number; balance: number | null }> {
  const required = await prechargeFor(supabase, ability)
  const balance = await readBalance(supabase, userId)
  if (balance === null) return { ok: true, required, balance: null }
  return { ok: balance >= required, required, balance }
}

/**
 * 阶段一：调用前预扣。
 *
 * 余额不足时返回 `insufficient_balance`，调用方**必须**据此拒绝发起 LLM 调用。
 * 幂等键为 `${refId}:reserve`——同一个业务号重复预扣只会扣一次，
 * 这让"前端重发 / 网关重试"不会变成扣两次。
 */
export async function reserveAiCost(params: {
  supabase: SupabaseClient
  userId: string
  ability: AiAbility
  refId: string
  description?: string
}): Promise<AiReserveResult> {
  const amount = await prechargeFor(params.supabase, params.ability)
  const r = await consumePoints(params.supabase, params.userId, amount, {
    refId: `${params.refId}:reserve`,
    source: 'ai',
    description: params.description ?? `AI ${params.ability} 预扣`,
  })
  if (r.ok) {
    // duplicated：这个业务号已经预扣过了（前端重发 / 网关重试 /
    // 或同一次请求里两次调用复用了同一个 refId）。此时**并没有真的扣到钱**——
    // consume_points 命中幂等键会直接返回，不二次扣减。
    //
    // 所以这里必须老实回 reserved=0。调用方是拿 reserved 去结算的：
    // 一旦谎报"我扣了 amount"，结算就会把这笔根本没扣过的钱"退"给用户，
    // 等于凭空造积分。宁可这一次少收，也不能让账目自己生钱。
    const duplicated = r.duplicated === true
    return { ok: true, reserved: duplicated ? 0 : amount, balance: r.balance, duplicated }
  }
  return {
    ok: false,
    code: r.code === 'insufficient_balance' ? 'insufficient_balance' : 'error',
    required: amount,
    balance: 'balance' in r ? r.balance : undefined,
  }
}

export interface AiSettleResult {
  /** 按真实 token 用量算出的积分（最终成本） */
  actual: number
  /** 预扣时扣掉的积分 */
  reserved: number
  /** 结算时补扣的差额（0 = 未补扣） */
  extraCharged: number
  /** 结算时退回的差额（0 = 未退款） */
  refunded: number
  /** 结算后的余额；null = 没能查到 */
  balance: number | null
}

/**
 * 阶段二：调用后按真实用量结算。
 *
 * 失败**不抛错、不阻断**：作品已经生成好了，记账失败最多是少收钱，
 * 绝不能因为记账把作品弄丢。所有异常都吞掉并留日志（§红线②）。
 */
export async function settleAiCost(params: {
  supabase: SupabaseClient
  userId: string
  refId: string
  /** 阶段一实际预扣到的积分 */
  reserved: number
  /** 本次调用的 token 用量；缺失按零用量处理（最终按保底积分计） */
  usage?: TokenUsage | null
  description?: string
}): Promise<AiSettleResult> {
  const cfg = await getPointConfig(params.supabase)
  const usage = params.usage ?? ZERO_USAGE
  const actual = chargePointsForUsage(usage, cfg.pointsPerYuan)
  const reserved = Math.max(0, params.reserved)

  let extraCharged = 0
  let refunded = 0
  let balance: number | null = null

  const diff = actual - reserved

  if (diff > 0) {
    const r = await consumePoints(params.supabase, params.userId, diff, {
      refId: `${params.refId}:settle`,
      source: 'ai',
      description: params.description ?? `AI 结算补扣（实际 ${actual} 积分）`,
    })
    if (r.ok) {
      extraCharged = diff
      balance = r.balance
    } else {
      console.warn('[aiCost] 结算补扣失败:', r.code)
    }
  } else if (diff < 0) {
    const r = await refundPoints(params.supabase, params.userId, -diff, {
      refId: `${params.refId}:refund`,
      description: params.description ?? `AI 结算退还（预扣 ${reserved} / 实际 ${actual}）`,
    })
    if (r.ok) {
      refunded = -diff
      balance = r.balance
    } else {
      console.warn('[aiCost] 结算退款失败:', r.code)
    }
  } else {
    // 正好等于预扣：无需补扣也无需退款
    const cfgBalance = await readBalance(params.supabase, params.userId)
    balance = cfgBalance
  }

  return { actual, reserved, extraCharged, refunded, balance }
}

/**
 * LLM 调用失败时全额退回预扣。
 *
 * 没生成出任何东西却扣了积分，是最伤信任的事故——
 * 宁可少收这一次钱，也不能让用户觉得"平台抢钱"。
 */
export async function refundAiCost(params: {
  supabase: SupabaseClient
  userId: string
  refId: string
  amount: number
  reason?: string
}): Promise<{ ok: boolean; refunded: number }> {
  if (params.amount <= 0) return { ok: true, refunded: 0 }
  const r = await refundPoints(params.supabase, params.userId, params.amount, {
    refId: `${params.refId}:failed`,
    description: params.reason ?? 'AI 调用失败，预扣全额退还',
  })
  if (!r.ok) {
    console.warn('[aiCost] 失败退款未成功:', r.code)
    return { ok: false, refunded: 0 }
  }
  return { ok: true, refunded: r.refunded }
}

/** 读余额（内部用；失败返回 null，与 lib/points 的 fail-open 口径一致） */
async function readBalance(supabase: SupabaseClient, userId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('user_balances')
    .select('balance')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return null
  const v = typeof data?.balance === 'number' ? data.balance : Number(data?.balance)
  return Number.isFinite(v) ? v : null
}
