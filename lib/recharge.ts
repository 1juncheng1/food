// ============================================================
// lib/recharge —— 充值订单与收款码（Phase 2）
//
// 人工收款模式的核心纪律，全写在这里：
//
//   ① 前端展示的永远是「预计获得积分」，不是实际到账积分。
//      最终积分 = 管理员核实的实际到账金额 × 汇率，由服务端算。
//   ② 「我已付款」只改状态（PENDING → PAID），**不给一分积分**。
//      PAID 是用户的一面之词，不是资金事实。
//   ③ 金额下限/上限由服务端读配置校验，前端的校验只是提前提示。
//
// 这个函数库刻意保持「只接受一个 SupabaseClient」的形态：
//   用户端调用传的是**用户 token 客户端**（RLS 保证只看得到自己的订单），
//   管理员端（Phase 3）传的是 service_role 客户端。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_MIN_RECHARGE_AMOUNT,
  getPointConfig,
  pointsForAmount,
  type PointConfig,
} from '@/lib/points'

/** 订单状态（与 SQL check 约束一一对应） */
export const ORDER_STATUSES = ['PENDING', 'PAID', 'CONFIRMED', 'CANCELLED', 'REJECTED'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/** 状态 → 用户可读文案（前端与后台共用，避免两处措辞漂移） */
export const ORDER_STATUS_TEXT: Record<OrderStatus, string> = {
  PENDING: '待付款',
  PAID: '待确认',
  CONFIRMED: '已到账',
  CANCELLED: '已取消',
  REJECTED: '未收到款',
}

export interface RechargeOrder {
  id: string
  orderNo: string
  userId: string
  /** 用户申请金额（元） */
  requestedAmount: number
  /** 管理员核实的实际到账金额（元）；未确认为 null */
  confirmedAmount: number | null
  /** 实际入账积分；未确认为 null */
  points: number | null
  status: OrderStatus
  userNote: string | null
  adminNote: string | null
  createdAt: string
  paidAt: string | null
  confirmedAt: string | null
}

export interface PaymentSettings {
  method: string
  qrImageUrl: string | null
  accountName: string | null
  instruction: string | null
}

/** 充值页所需的全部配置：收款码 + 价格口径 */
export interface RechargeConfig {
  payment: PaymentSettings
  pointsPerYuan: number
  minAmount: number
  maxAmount: number
  registerBonusPoints: number
}

/** 兜底收款配置（数据库没配时也不至于白屏；管理员需在后台补上二维码） */
const FALLBACK_PAYMENT: PaymentSettings = {
  method: '微信',
  qrImageUrl: null,
  accountName: null,
  instruction: '请使用收款码付款，付款后点击「我已付款」，等待管理员确认到账。',
}

/** numeric 经 PostgREST 可能是 number 也可能是 string */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function toStatus(v: unknown): OrderStatus | null {
  return typeof v === 'string' && (ORDER_STATUSES as readonly string[]).includes(v)
    ? (v as OrderStatus)
    : null
}

/** 数据库行 → RechargeOrder（脏数据返回 null，绝不把 undefined 渲染给用户） */
export function normalizeOrder(row: Record<string, unknown>): RechargeOrder | null {
  const id = typeof row.id === 'string' ? row.id : ''
  const orderNo = typeof row.order_no === 'string' ? row.order_no : ''
  const userId = typeof row.user_id === 'string' ? row.user_id : ''
  const requested = toNumber(row.requested_amount)
  const status = toStatus(row.status)
  if (!id || !orderNo || !userId || requested === null || !status) return null

  return {
    id,
    orderNo,
    userId,
    requestedAmount: requested,
    confirmedAmount: toNumber(row.confirmed_amount),
    points: toNumber(row.points),
    status,
    userNote: typeof row.user_note === 'string' ? row.user_note : null,
    adminNote: typeof row.admin_note === 'string' ? row.admin_note : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    paidAt: typeof row.paid_at === 'string' ? row.paid_at : null,
    confirmedAt: typeof row.confirmed_at === 'string' ? row.confirmed_at : null,
  }
}

/**
 * 读取充值页需要的全部配置（收款码 + 汇率 + 金额门槛）。
 *
 * 失败时回落到兜底值：配置读不到不该让"充值"这个动作彻底不可用，
 * 但**收款码为空时前端必须提示用户联系管理员**，而不是展示一张空白图。
 */
export async function fetchRechargeConfig(supabase: SupabaseClient): Promise<RechargeConfig> {
  const cfg: PointConfig = await getPointConfig(supabase)
  let payment = FALLBACK_PAYMENT

  try {
    const { data, error } = await supabase
      .from('payment_settings')
      .select('method, qr_image_url, account_name, instruction')
      .eq('id', 1)
      .maybeSingle()
    if (!error && data) {
      const r = data as Record<string, unknown>
      payment = {
        method: typeof r.method === 'string' && r.method.trim() ? r.method : FALLBACK_PAYMENT.method,
        qrImageUrl: typeof r.qr_image_url === 'string' && r.qr_image_url.trim() ? r.qr_image_url : null,
        accountName: typeof r.account_name === 'string' && r.account_name.trim() ? r.account_name : null,
        instruction:
          typeof r.instruction === 'string' && r.instruction.trim()
            ? r.instruction
            : FALLBACK_PAYMENT.instruction,
      }
    }
  } catch (e) {
    console.error('[recharge] 读取收款配置异常:', e)
  }

  return {
    payment,
    pointsPerYuan: cfg.pointsPerYuan,
    minAmount: cfg.minRechargeAmount,
    maxAmount: cfg.maxRechargeAmount,
    registerBonusPoints: cfg.registerBonusPoints,
  }
}

/**
 * 金额校验（服务端唯一口径）。
 * @returns null = 合法；否则是可直接展示给用户的中文原因
 */
export function validateAmount(
  amount: unknown,
  cfg: { min: number; max: number }
): { code: 'bad_amount' | 'below_min' | 'above_max'; message: string } | null {
  const n = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(n) || n <= 0) {
    return { code: 'bad_amount', message: '请输入正确的充值金额' }
  }
  if (n < cfg.min) {
    return { code: 'below_min', message: `最低充值金额为 ${cfg.min} 元` }
  }
  if (n > cfg.max) {
    return { code: 'above_max', message: `单笔充值上限为 ${cfg.max} 元，如需更大金额请联系管理员` }
  }
  return null
}

/** 「预计获得积分」：仅用于展示，绝不能作为入账依据 */
export function estimatePoints(amount: number, pointsPerYuan: number): number {
  return pointsForAmount(amount, pointsPerYuan)
}

export type CreateOrderResult =
  | { ok: true; order: RechargeOrder; duplicated: false }
  | { ok: false; code: 'unauthenticated' | 'bad_amount' | 'below_min' | 'above_max' | 'error'; message: string }

/**
 * 创建充值订单（走 RPC，金额校验在数据库里按配置执行）。
 */
export async function createRechargeOrder(
  supabase: SupabaseClient,
  amount: number,
  note?: string
): Promise<CreateOrderResult> {
  const { data, error } = await supabase.rpc('create_recharge_order', {
    p_amount: amount,
    p_note: note ?? null,
  })

  if (error) {
    console.error('[recharge] create_recharge_order 失败:', error.message)
    return { ok: false, code: 'error', message: '创建订单失败，请稍后重试' }
  }

  const r = (data ?? {}) as { ok?: unknown; code?: unknown; min?: unknown; max?: unknown; order?: unknown }
  if (r.ok === true) {
    const order = normalizeOrder((r.order ?? {}) as Record<string, unknown>)
    if (order) return { ok: true, order, duplicated: false }
    return { ok: false, code: 'error', message: '创建订单失败，请稍后重试' }
  }

  const code = r.code
  if (code === 'below_min') {
    return { ok: false, code: 'below_min', message: `最低充值金额为 ${String(r.min ?? DEFAULT_MIN_RECHARGE_AMOUNT)} 元` }
  }
  if (code === 'above_max') {
    return { ok: false, code: 'above_max', message: `单笔充值上限为 ${String(r.max)} 元` }
  }
  if (code === 'unauthenticated') {
    return { ok: false, code: 'unauthenticated', message: '请先登录' }
  }
  return { ok: false, code: 'bad_amount', message: '请输入正确的充值金额' }
}

/** 用户点「我已付款」：PENDING → PAID（不加积分） */
export async function markOrderPaid(
  supabase: SupabaseClient,
  orderId: string
): Promise<{ ok: true; status: OrderStatus; changed: boolean } | { ok: false; message: string }> {
  const { data, error } = await supabase.rpc('mark_recharge_paid', { p_order_id: orderId })
  if (error) {
    console.error('[recharge] mark_recharge_paid 失败:', error.message)
    return { ok: false, message: '操作失败，请稍后重试' }
  }
  const r = (data ?? {}) as { ok?: unknown; status?: unknown; changed?: unknown }
  const status = toStatus(r.status)
  if (r.ok === true && status) {
    return { ok: true, status, changed: r.changed === true }
  }
  return { ok: false, message: '订单不存在或状态已变更' }
}

/** 用户取消订单 */
export async function cancelOrder(
  supabase: SupabaseClient,
  orderId: string
): Promise<{ ok: true; status: OrderStatus } | { ok: false; message: string }> {
  const { data, error } = await supabase.rpc('cancel_recharge_order', { p_order_id: orderId })
  if (error) {
    console.error('[recharge] cancel_recharge_order 失败:', error.message)
    return { ok: false, message: '操作失败，请稍后重试' }
  }
  const r = (data ?? {}) as { ok?: unknown; status?: unknown }
  const status = toStatus(r.status)
  if (r.ok === true && status) return { ok: true, status }
  return { ok: false, message: '订单无法取消（已确认或已关闭）' }
}

/** 我的充值订单（新在前） */
export async function listMyOrders(
  supabase: SupabaseClient,
  userId: string,
  limit = 20
): Promise<RechargeOrder[]> {
  const { data, error } = await supabase
    .from('recharge_orders')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error || !Array.isArray(data)) {
    if (error) console.error('[recharge] 查询订单失败:', error.message)
    return []
  }
  return data.map((r) => normalizeOrder(r as Record<string, unknown>)).filter((o): o is RechargeOrder => o !== null)
}

/** 按订单号查（用户看自己的订单详情；管理员端走 service_role 可查任意订单） */
export async function getOrderByNo(
  supabase: SupabaseClient,
  orderNo: string
): Promise<RechargeOrder | null> {
  const { data, error } = await supabase
    .from('recharge_orders')
    .select('*')
    .eq('order_no', orderNo)
    .maybeSingle()
  if (error || !data) return null
  return normalizeOrder(data as Record<string, unknown>)
}
