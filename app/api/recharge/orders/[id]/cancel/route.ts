// ============================================================
// POST /api/recharge/orders/[id]/cancel —— 用户取消自己的订单
//
// 只能取消 PENDING / PAID。已确认（钱到账了）或已拒绝的订单
// 由数据库终态守卫直接挡下，接口这里只是把错误信息翻成人话。
// ============================================================

import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/apiAuth'
import { rateLimit } from '@/lib/rateLimit'
import { cancelOrder } from '@/lib/recharge'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' } as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id || !UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: '无效的订单 ID' }, { status: 400, headers: NO_STORE })
  }

  const auth = await authenticateRequest(req, '请先登录')
  if (!auth.ok) return auth.response

  const rl = rateLimit(`recharge-cancel:${auth.userId}`, 10, 60_000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: '操作过于频繁，请稍后再试' },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfterSec) } }
    )
  }

  const result = await cancelOrder(auth.supabase, id)
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 400, headers: NO_STORE })
  }

  return NextResponse.json({ status: result.status }, { headers: NO_STORE })
}
