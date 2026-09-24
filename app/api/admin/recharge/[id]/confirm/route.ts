// ============================================================
// POST /api/admin/recharge/[id]/confirm —— 管理员确认到账
//
// body: { amount: number（**实际到账金额，不是用户申请金额**）, note?: string }
//
// 这是全系统唯一能产生充值积分的入口。三条硬约束：
//   · 必须管理员（requireAdmin）
//   · 必须 service_role 通道（RPC 内部再查一次 is_service_caller）
//   · 客户端传的是钱，不是积分 —— 积分由服务端按 POINTS_PER_YUAN 算
//
// 幂等：重复点击返回 duplicated:true 且积分不变，不报错（管理员不该看到红字，
// 但响应里带 duplicated 标记，前端可以提示"该订单已确认过"）。
// ============================================================

import { NextResponse } from 'next/server'
import { requireAdmin, requireServiceClient } from '@/lib/adminAuth'
import { confirmRecharge } from '@/lib/adminPoints'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' } as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NOTE = 200

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id || !UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: '无效的订单 ID' }, { status: 400, headers: NO_STORE })
  }

  const admin = await requireAdmin(req)
  if (!admin.ok) return admin.response

  const svc = await requireServiceClient()
  if (!svc.ok) return svc.response

  let body: { amount?: unknown; note?: unknown }
  try {
    body = (await req.json()) ?? {}
  } catch {
    return NextResponse.json({ error: '请求格式有误' }, { status: 400, headers: NO_STORE })
  }

  const amount = typeof body.amount === 'number' ? body.amount : Number(body.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: '请填写实际到账金额' },
      { status: 400, headers: NO_STORE }
    )
  }

  let note: string | undefined
  if (typeof body.note === 'string' && body.note.trim()) {
    if (body.note.length > MAX_NOTE) {
      return NextResponse.json({ error: `备注最多 ${MAX_NOTE} 字` }, { status: 400, headers: NO_STORE })
    }
    note = body.note.trim()
  }

  const result = await confirmRecharge(svc.db, id, amount, admin.auth.userId, note)
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 400, headers: NO_STORE })
  }

  return NextResponse.json(
    {
      ok: true,
      duplicated: result.duplicated,
      points: result.points,
      balance: result.balance,
      confirmedAmount: result.confirmedAmount,
    },
    { headers: NO_STORE }
  )
}
