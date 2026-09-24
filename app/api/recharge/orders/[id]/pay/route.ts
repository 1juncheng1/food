// ============================================================
// POST /api/recharge/orders/[id]/pay —— 用户点「我已付款」
//
// 这个接口**只做一件事**：PENDING → PAID。
//
// 它绝不加积分、不改金额、不碰余额。理由写在 lib/recharge.ts 顶部：
// 用户说"我付了"是流程状态，不是资金事实；只有管理员确认的
// CONFIRMED 才允许产生积分。
//
// 幂等：重复点击返回当前状态 + changed:false，不报错（用户手抖不该看到红字）。
// ============================================================

import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/apiAuth'
import { rateLimit } from '@/lib/rateLimit'
import { markOrderPaid } from '@/lib/recharge'

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

  const rl = rateLimit(`recharge-pay:${auth.userId}`, 10, 60_000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: '操作过于频繁，请稍后再试' },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfterSec) } }
    )
  }

  const result = await markOrderPaid(auth.supabase, id)
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 400, headers: NO_STORE })
  }

  return NextResponse.json(
    { status: result.status, changed: result.changed },
    { headers: NO_STORE }
  )
}
