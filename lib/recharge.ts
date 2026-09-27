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
import {
  ManualPaymentProvider,
  getPaymentProvider,
  type PaymentProviderId,
} from '@/lib/paymentProvider'

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
  /** 支付通道：MVP 恒为 MANUAL（人工收款）；未来接正式支付时按通道区分处理 */
  provider: PaymentProviderId
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

/** 充值页所需的全部配置：收款码 + 价格口径 + 支付通道 + 快捷档位 */
export interface RechargeConfig {
  payment: PaymentSettings
  pointsPerYuan: number
  minAmount: number
  maxAmount: number
  registerBonusPoints: number
  /** 当前生效的支付通道（MVP 恒为人工收款） */
  provider: {
    id: PaymentProviderId
    label: string
    /** false ⇒ 必须管理员确认才加积分 */
    autoConfirm: boolean
  }
  /** 快捷充值档位（元）：来自数据库，前端不得硬编码 */
  quickAmounts: number[]
}

/** 收款码没配时的兜底档位（与迁移里的默认值一致） */
export const FALLBACK_QUICK_AMOUNTS: number[] = [5, 10, 20, 50, 100]

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
    // 未知通道值回落到 MANUAL（保守方向：走人工确认，绝不自动加积分）
    provider: getPaymentProvider(typeof row.provider === 'string' ? row.provider : null).id,
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
  let quickAmounts = FALLBACK_QUICK_AMOUNTS

  try {
    // 迁移 0020 之前没有 quick_amounts 列：列不存在会整条查询报错，
    // 那样连收款码都读不到。所以分两步查——先只查收款码（永远可用），
    // 再单独试档位，失败就回落默认档位。
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

  try {
    const { data, error } = await supabase
      .from('payment_settings')
      .select('quick_amounts')
      .eq('id', 1)
      .maybeSingle()
    if (!error && data) {
      const parsed = parseQuickAmounts((data as Record<string, unknown>).quick_amounts)
      if (parsed.length > 0) quickAmounts = parsed
    }
  } catch {
    // 列还没建 / 读不到：用默认档位，不影响充值本身可用
  }

  return {
    payment,
    pointsPerYuan: cfg.pointsPerYuan,
    minAmount: cfg.minRechargeAmount,
    maxAmount: cfg.maxRechargeAmount,
    registerBonusPoints: cfg.registerBonusPoints,
    provider: {
      id: ManualPaymentProvider.id,
      label: ManualPaymentProvider.label,
      autoConfirm: ManualPaymentProvider.autoConfirm,
    },
    quickAmounts,
  }
}

/**
 * 解析数据库里的快捷档位。
 *
 * 容忍三种形态：PostgREST 把 numeric[] 直接给成数组，也可能给成
 * `{5,10,20,50,100}` 这样的字符串。脏数据（负数/0/非数字）直接丢掉——
 * 宁可少一个档位，也不能渲染出一个点下去必然报错的按钮。
 */
export function parseQuickAmounts(v: unknown): number[] {
  let raw: unknown[] = []
  if (Array.isArray(v)) {
    raw = v
  } else if (typeof v === 'string') {
    raw = v.replace(/^\{|\}$/g, '').split(',').map((s) => s.trim())
  }
  const out: number[] = []
  for (const item of raw) {
    const n = toNumber(item)
    if (n !== null && n > 0 && !out.includes(n)) out.push(n)
  }
  return out.sort((a, b) => a - b)
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
    // 走到这里说明**订单已经在库里建成功了**，只是返回的行解析不出来
    // （典型原因：RPC 返回的字段名/形状与 normalizeOrder 的 snake_case 约定不一致）。
    // 必须把原始载荷打出来——否则只会看到一句「创建订单失败」，无从下手。
    console.error(
      '[recharge] 订单已创建但返回行无法解析，检查 create_recharge_order 的返回形状:',
      JSON.stringify(r.order)
    )
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
