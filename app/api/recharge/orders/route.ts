// ============================================================
// /api/recharge/orders
//   POST 创建充值订单（金额校验在数据库里按 point_config 执行）
//   GET  我的充值订单列表
//
// 这里刻意**不接受客户端传的积分**：body 只有金额与备注。
// 「充多少钱换多少积分」是服务端按配置算的，客户端算的那份只配叫"预计"。
//
// 限流 5 次/分钟：人工审核模式下，一堆无效订单会直接压垮管理员的核对队列。
// ============================================================

import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/apiAuth'
import { rateLimit } from '@/lib/rateLimit'
import { createRechargeOrder, listMyOrders } from '@/lib/recharge'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

/** 备注长度上限：这是给管理员看的核对线索，不是留言板 */
const MAX_NOTE_LENGTH = 200

export async function POST(req: Request) {
  const auth = await authenticateRequest(req, '请先登录后再充值')
  if (!auth.ok) return auth.response

  const rl = rateLimit(`recharge:${auth.userId}`, 5, 60_000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: '操作过于频繁，请稍后再试' },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfterSec) } }
    )
  }

  let body: { amount?: unknown; note?: unknown }
  try {
    body = (await req.json()) ?? {}
  } catch {
    return NextResponse.json({ error: '请求格式有误' }, { status: 400, headers: NO_STORE })
  }

  const amount = typeof body.amount === 'number' ? body.amount : Number(body.amount)
  if (!Number.isFinite(amount)) {
    return NextResponse.json({ error: '请输入正确的充值金额' }, { status: 400, headers: NO_STORE })
  }

  let note: string | undefined
  if (typeof body.note === 'string' && body.note.trim()) {
    if (body.note.length > MAX_NOTE_LENGTH) {
      return NextResponse.json(
        { error: `备注最多 ${MAX_NOTE_LENGTH} 字` },
        { status: 400, headers: NO_STORE }
      )
    }
    note = body.note.trim()
  }

  const result = await createRechargeOrder(auth.supabase, amount, note)
  if (!result.ok) {
    const status =
      result.code === 'unauthenticated' ? 401 : result.code === 'error' ? 500 : 400
    return NextResponse.json(
      { error: result.message, code: result.code },
      { status, headers: NO_STORE }
    )
  }

  return NextResponse.json({ order: result.order }, { status: 201, headers: NO_STORE })
}

export async function GET(req: Request) {
  const auth = await authenticateRequest(req, '请先登录')
  if (!auth.ok) return auth.response

  // RLS 已限定只能读自己的订单，这里再显式限定一次（纵深防御）
  const orders = await listMyOrders(auth.supabase, auth.userId)

  return NextResponse.json({ orders }, { headers: NO_STORE })
}
