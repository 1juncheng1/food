// ============================================================
// GET /api/recharge/config —— 充值页所需配置（收款码 + 价格口径）
//
// 返回：{ payment:{method,qrImageUrl,accountName,instruction},
//         pointsPerYuan, minAmount, maxAmount, registerBonusPoints }
//
// 为什么走接口而不是让前端直接查 payment_settings：
//   汇率与金额门槛要和服务端同一个来源（point_config）。前端自己读一遍
//   就必然出现"页面说 200 积分、到账 190 积分"的口径分裂。
//
// 安全：收款码 URL 只从数据库读，不接受任何入参。
// ============================================================

import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/apiAuth'
import { fetchRechargeConfig } from '@/lib/recharge'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const auth = await authenticateRequest(req, '请先登录后再充值')
  if (!auth.ok) return auth.response

  const config = await fetchRechargeConfig(auth.supabase)

  return NextResponse.json(config, { headers: { 'Cache-Control': 'no-store' } })
}
