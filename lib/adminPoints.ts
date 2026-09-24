// ============================================================
// lib/adminPoints —— 管理端积分操作（Phase 3）
//
// 这里是**全系统唯一能凭空产生积分**的地方，因此每个函数都守三条：
//
//   ① 必须由 service_role 客户端调用（RPC 内部还会再查一次 is_service_caller）
//   ② 管理员不传积分、只传金额 —— 积分永远由服务端按配置算
//   ③ 每次操作都要能被 point_ledger 追到：谁、什么时候、因为什么、改了多少
//
// 幂等不是靠"小心一点"，是靠数据库唯一索引：
//   · 充值：reference_id = 订单号
//   · 手动调整：reference_id = 本次生成的调整单号
//   同一个号第二次进来，撞约束 → 零副作用。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeOrder, type OrderStatus, type RechargeOrder } from '@/lib/recharge'

/** 手动调整单号：每次操作一个新号，是幂等键也是审计线索 */
export function makeAdjustmentRef(): string {
  return `ADJ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

/** 管理员视角的充值订单列表（RLS 已为管理员放开跨用户读） */
export async function listRechargeOrders(
  db: SupabaseClient,
  opts: { status?: OrderStatus | 'ALL'; limit?: number } = {}
): Promise<RechargeOrder[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100)
  let query = db
    .from('recharge_orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (opts.status && opts.status !== 'ALL') query = query.eq('status', opts.status)

  const { data, error } = await query
  if (error) {
    console.error('[admin] 查询充值订单失败:', error.message)
    return []
  }
  if (!Array.isArray(data)) return []
  return data
    .map((r) => normalizeOrder(r as Record<string, unknown>))
    .filter((o): o is RechargeOrder => o !== null)
}

/**
 * 批量取用户邮箱（管理员核账时要知道"这笔钱是谁付的"）。
 *
 * auth.users 不在 RLS 覆盖范围内，只能走 service 的 admin API；
 * 单个失败不影响整体（邮箱只是辅助信息，缺了就显示用户 ID 短码）。
 */
export async function attachUserEmails(
  db: SupabaseClient,
  userIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(userIds)].slice(0, 50)
  await Promise.all(
    unique.map(async (uid) => {
      try {
        const { data, error } = await db.auth.admin.getUserById(uid)
        if (!error && data?.user?.email) out.set(uid, data.user.email)
      } catch {
        // 忽略：邮箱取不到不影响核账
      }
    })
  )
  return out
}

export type ConfirmResult =
  | { ok: true; duplicated: boolean; points: number; balance: number; confirmedAmount: number | null }
  | { ok: false; message: string }

/**
 * 确认到账：按**实际到账金额**计算积分。
 *
 * 用户申请 10 元、实际到账 20 元 → 管理员填 20 → 入账 400 积分。
 * 反过来少付也一样，以管理员核实的为准。
 */
export async function confirmRecharge(
  db: SupabaseClient,
  orderId: string,
  amount: number,
  adminId: string,
  note?: string
): Promise<ConfirmResult> {
  const { data, error } = await db.rpc('confirm_recharge', {
    p_order_id: orderId,
    p_amount: amount,
    p_admin_id: adminId,
    p_note: note ?? null,
  })

  if (error) {
    console.error('[admin] confirm_recharge 失败:', error.message)
    return { ok: false, message: '确认失败，请稍后重试' }
  }

  const r = (data ?? {}) as {
    ok?: unknown
    code?: unknown
    duplicated?: unknown
    points?: unknown
    balance?: unknown
    confirmedAmount?: unknown
  }

  if (r.ok === true) {
    return {
      ok: true,
      duplicated: r.duplicated === true,
      points: Number(r.points ?? 0),
      balance: Number(r.balance ?? 0),
      confirmedAmount: r.confirmedAmount === undefined || r.confirmedAmount === null
        ? null
        : Number(r.confirmedAmount),
    }
  }

  const code = String(r.code ?? '')
  if (code === 'not_found') return { ok: false, message: '订单不存在' }
  if (code === 'already_closed') return { ok: false, message: '该订单已关闭（已取消或已拒绝），无法确认' }
  if (code === 'bad_amount') return { ok: false, message: '请填写正确的实际到账金额' }
  if (code === 'forbidden') return { ok: false, message: '无权执行该操作' }
  return { ok: false, message: '确认失败，请稍后重试' }
}

/** 拒绝到账（未收到款）：只改状态，不加积分 */
export async function rejectRecharge(
  db: SupabaseClient,
  orderId: string,
  adminId: string,
  note?: string
): Promise<{ ok: true; duplicated: boolean } | { ok: false; message: string }> {
  const { data, error } = await db.rpc('reject_recharge', {
    p_order_id: orderId,
    p_admin_id: adminId,
    p_note: note ?? null,
  })
  if (error) {
    console.error('[admin] reject_recharge 失败:', error.message)
    return { ok: false, message: '操作失败，请稍后重试' }
  }
  const r = (data ?? {}) as { ok?: unknown; code?: unknown; duplicated?: unknown }
  if (r.ok === true) return { ok: true, duplicated: r.duplicated === true }
  const code = String(r.code ?? '')
  if (code === 'not_found') return { ok: false, message: '订单不存在' }
  if (code === 'already_closed') return { ok: false, message: '该订单已确认或已取消，无法拒绝' }
  return { ok: false, message: '操作失败，请稍后重试' }
}

/**
 * 手动调整积分（+100 / -50 之类）。
 *
 * 强制要求：非零、有原因。没有原因的调整在三个月后就是一笔糊涂账。
 */
export async function adjustPoints(
  db: SupabaseClient,
  params: {
    userId: string
    delta: number
    reason: string
    adminId: string
    /** 幂等键；重复提交同一单号只会生效一次 */
    referenceId?: string
  }
): Promise<{ ok: true; balance: number; duplicated: boolean; referenceId: string } | { ok: false; message: string }> {
  const referenceId = params.referenceId ?? makeAdjustmentRef()
  const { data, error } = await db.rpc('adjust_points_manual', {
    p_user_id: params.userId,
    p_delta: params.delta,
    p_reason: params.reason,
    p_reference_id: referenceId,
    p_admin_id: params.adminId,
  })

  if (error) {
    console.error('[admin] adjust_points_manual 失败:', error.message)
    return { ok: false, message: '调整失败，请稍后重试' }
  }

  const r = (data ?? {}) as { ok?: unknown; code?: unknown; balance?: unknown; duplicated?: unknown }
  if (r.ok === true) {
    return {
      ok: true,
      balance: Number(r.balance ?? 0),
      duplicated: r.duplicated === true,
      referenceId,
    }
  }

  const code = String(r.code ?? '')
  if (code === 'insufficient_balance') return { ok: false, message: '扣减后余额会变成负数，已拒绝' }
  if (code === 'bad_params') return { ok: false, message: '请填写调整原因' }
  if (code === 'bad_amount') return { ok: false, message: '调整积分不能为 0' }
  if (code === 'forbidden') return { ok: false, message: '无权执行该操作' }
  return { ok: false, message: '调整失败，请稍后重试' }
}

/** 更新收款码配置（单行表，upsert id=1） */
export async function updatePaymentSettings(
  db: SupabaseClient,
  patch: { method?: string; qrImageUrl?: string | null; accountName?: string | null; instruction?: string | null },
  adminId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  // 只写传了的字段，避免把别的字段清成 null
  const payload: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString(), updated_by: adminId }
  if (patch.method !== undefined) payload.method = patch.method
  if (patch.qrImageUrl !== undefined) payload.qr_image_url = patch.qrImageUrl
  if (patch.accountName !== undefined) payload.account_name = patch.accountName
  if (patch.instruction !== undefined) payload.instruction = patch.instruction

  const { error } = await db.from('payment_settings').upsert(payload, { onConflict: 'id' })
  if (error) {
    console.error('[admin] 更新收款配置失败:', error.message)
    return { ok: false, message: '保存失败，请稍后重试' }
  }
  return { ok: true }
}

/** 改价格配置（改价不碰代码的关键就在这张表） */
export async function updatePointConfig(
  db: SupabaseClient,
  key: string,
  value: number,
  adminId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await db.from('point_config').upsert(
    { key, value, updated_at: new Date().toISOString(), updated_by: adminId },
    { onConflict: 'key' }
  )
  if (error) {
    console.error('[admin] 更新积分配置失败:', error.message)
    return { ok: false, message: '保存失败，请稍后重试' }
  }
  return { ok: true }
}
