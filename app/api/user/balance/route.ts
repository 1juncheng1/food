// ============================================================
// GET /api/user/balance —— 查询当前登录用户的账户余额
//
// 返回：{ balance: number, noBalance: boolean, message: string | null }
//
// 鉴权：必须登录（余额是私域数据），走 lib/apiAuth：
//   网络故障 → 503「网络异常」（已登录用户不得踢）
//   凭证失效 → 401
//
// 为什么要有这个接口而不是让前端直接查 Supabase：
//   1. 前端拿到的 anon key 受 RLS 约束，但"余额为 0 时提示充值"这条业务规则
//      必须在服务端有唯一出处，否则 Web/未来的小程序各写一遍必然漂移；
//   2. ensure_balance 的赠送额度是服务端策略，不该暴露给客户端随意传参。
//
// fail-open：余额**读取失败**时返回 200 + balance:null，而不是 0。
// 把"查不到"说成"没钱"会让用户在数据库抖动时看到"请充值"，这是冤枉人。
// ============================================================

import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/apiAuth'
import { NO_BALANCE_MESSAGE, ensureBalance } from '@/lib/balance'
import { getPointConfig } from '@/lib/points'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const auth = await authenticateRequest(req)
  if (!auth.ok) return auth.response

  const balance = await ensureBalance(auth.supabase, auth.userId)

  // 汇率与最低消费一并下发（Phase 5）：
  // 前端此前把「20 积分 ≈ ¥0.5」写死在文案里，管理员在后台一改价就必然漂移。
  // 现在价格只有一个出处——point_config，前端只负责展示。
  const cfg = await getPointConfig(auth.supabase)

  // null = 读不到（失败），前端据此不展示、不拦截；0 = 确实没钱
  return NextResponse.json(
    {
      balance,
      noBalance: balance === 0,
      message: balance === 0 ? NO_BALANCE_MESSAGE : null,
      pointsPerYuan: cfg.pointsPerYuan,
      minGenerationCost: cfg.minGenerationCost,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
