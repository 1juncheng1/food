// ============================================================
// POST /api/admin/recharge/[id]/reject —— 管理员拒绝（未收到款）
//
// 这个接口**一分积分都不加**，只把订单推进到 REJECTED。
// 已确认/已取消的订单由 RPC 直接挡下——钱都到账了就不能再反悔。
// ============================================================

import { NextResponse } from 'next/server'
import { requireAdmin, requireServiceClient } from '@/lib/adminAuth'
import { rejectRecharge } from '@/lib/adminPoints'

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

  let body: { note?: unknown } = {}
  try {
    body = (await req.json()) ?? {}
  } catch {
    // 备注是可选的，解析失败按空处理
  }

  let note: string | undefined
  if (typeof body.note === 'string' && body.note.trim()) {
    if (body.note.length > MAX_NOTE) {
      return NextResponse.json({ error: `备注最多 ${MAX_NOTE} 字` }, { status: 400, headers: NO_STORE })
    }
    note = body.note.trim()
  }

  const result = await rejectRecharge(svc.db, id, admin.auth.userId, note)
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 400, headers: NO_STORE })
  }

  return NextResponse.json({ ok: true, duplicated: result.duplicated }, { headers: NO_STORE })
}
