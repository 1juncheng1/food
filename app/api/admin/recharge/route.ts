// ============================================================
// GET /api/admin/recharge —— 充值订单管理列表
//
// 权限：admin_users 白名单（requireAdmin），RLS 另为管理员放开跨用户读。
// 邮箱：走 service 的 auth.admin.getUserById，取不到就只显示用户 ID 短码。
//
// 列表只做展示；**任何状态变更都不在这里发生**，
// 确认/拒绝各有自己的路由，方便审计与限流。
// ============================================================

import { NextResponse } from 'next/server'
import { requireAdmin, requireServiceClient } from '@/lib/adminAuth'
import { attachUserEmails, listRechargeOrders } from '@/lib/adminPoints'
import { ORDER_STATUSES, type OrderStatus } from '@/lib/recharge'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

export async function GET(req: Request) {
  const admin = await requireAdmin(req)
  if (!admin.ok) return admin.response

  const url = new URL(req.url)
  const statusParam = (url.searchParams.get('status') ?? 'PAID') as OrderStatus | 'ALL'
  const status = statusParam === 'ALL' || ORDER_STATUSES.includes(statusParam) ? statusParam : 'PAID'
  const limit = Number(url.searchParams.get('limit') ?? 30)

  const orders = await listRechargeOrders(admin.auth.supabase, { status, limit })

  // 邮箱是辅助信息：拿不到 service 客户端就跳过，不影响列表本身
  let emails: Record<string, string> = {}
  const svc = await requireServiceClient()
  if (svc.ok) {
    const map = await attachUserEmails(svc.db, orders.map((o) => o.userId))
    emails = Object.fromEntries(map)
  }

  return NextResponse.json({ orders, emails }, { headers: NO_STORE })
}
