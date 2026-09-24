// ============================================================
// GET /api/user/points/ledger —— 我的积分流水
//
// 存在的意义：让用户自己能核对"我的积分是怎么变的"。
// 人工收款模式下，到账时间取决于管理员，用户唯一的依靠就是这张流水——
// 没有它，每一次"我明明付了钱怎么还没到"都只能靠人工解释。
//
// 只读自己的：RLS 已限定 user_id = auth.uid()，这里再显式限定一次。
// ============================================================

import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/apiAuth'
import { fetchMyLedger } from '@/lib/points'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

export async function GET(req: Request) {
  const auth = await authenticateRequest(req, '请先登录')
  if (!auth.ok) return auth.response

  const url = new URL(req.url)
  const limit = Number(url.searchParams.get('limit') ?? 50)

  const entries = await fetchMyLedger(auth.supabase, auth.userId, limit)

  return NextResponse.json({ entries }, { headers: NO_STORE })
}
