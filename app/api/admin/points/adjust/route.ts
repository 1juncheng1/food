// ============================================================
// POST /api/admin/points/adjust —— 管理员手动调整积分
//
// body: { userId, delta（+加 / -减）, reason（必填） }
//
// 强制原因：三个月后回看一笔 +100，如果没有原因，它就只是一笔说不清的账。
// 每次调整都会生成调整单号写进 point_ledger.reference_id，
// 它既是审计线索，也是幂等键（重复提交同一单号只生效一次）。
// ============================================================

import { NextResponse } from 'next/server'
import { requireAdmin, requireServiceClient } from '@/lib/adminAuth'
import { adjustPoints } from '@/lib/adminPoints'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' } as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_REASON = 200
/** 单次调整上限：防止手滑多打一个 0，把 100 输成 10000 */
const MAX_ABS_DELTA = 100_000

export async function POST(req: Request) {
  const admin = await requireAdmin(req)
  if (!admin.ok) return admin.response

  const svc = await requireServiceClient()
  if (!svc.ok) return svc.response

  let body: { userId?: unknown; delta?: unknown; reason?: unknown }
  try {
    body = (await req.json()) ?? {}
  } catch {
    return NextResponse.json({ error: '请求格式有误' }, { status: 400, headers: NO_STORE })
  }

  const userId = typeof body.userId === 'string' ? body.userId : ''
  if (!userId || !UUID_PATTERN.test(userId)) {
    return NextResponse.json({ error: '请选择要调整的用户' }, { status: 400, headers: NO_STORE })
  }

  const delta = typeof body.delta === 'number' ? body.delta : Number(body.delta)
  if (!Number.isFinite(delta) || delta === 0) {
    return NextResponse.json({ error: '调整积分不能为 0' }, { status: 400, headers: NO_STORE })
  }
  if (Math.abs(delta) > MAX_ABS_DELTA) {
    return NextResponse.json(
      { error: `单次调整不得超过 ${MAX_ABS_DELTA} 积分` },
      { status: 400, headers: NO_STORE }
    )
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) {
    return NextResponse.json({ error: '请填写调整原因' }, { status: 400, headers: NO_STORE })
  }
  if (reason.length > MAX_REASON) {
    return NextResponse.json({ error: `原因最多 ${MAX_REASON} 字` }, { status: 400, headers: NO_STORE })
  }

  const result = await adjustPoints(svc.db, {
    userId,
    delta: Math.trunc(delta),
    reason,
    adminId: admin.auth.userId,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 400, headers: NO_STORE })
  }

  return NextResponse.json(
    {
      ok: true,
      balance: result.balance,
      duplicated: result.duplicated,
      referenceId: result.referenceId,
    },
    { headers: NO_STORE }
  )
}
