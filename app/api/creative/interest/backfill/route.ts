// ============================================================
// POST /api/creative/interest/backfill
// 一次性回填：把存量业务数据转为 creator_events。
// 回填后自动触发一次 full build，生成真实画像。
// 鉴权：Bearer token；限流：1 次/10 分钟（一次性操作）
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import { runBackfill } from '@/lib/creative/interest/backfill'
import { runBuild } from '@/lib/creative/interest/builder'
import { rateLimit } from '@/lib/rateLimit'

// 回填 + 自动 full build（含多次 LLM 调用），需放宽超时
export const maxDuration = 60
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const authHeader = req.headers.get('Authorization')
  const token = authHeader?.replace('Bearer ', '')
  if (!token) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }
  const supabase = createServerClient(token)
  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return authFailureResponse(authErr)
  }
  const userId = userData.user.id

  // ── 限流：一次性操作，严格限制（窗口必须是 600_000ms 而非 600ms）──
  const rl = rateLimit(`interest-backfill:${userId}`, 1, 10 * 60_000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: `回填操作过于频繁，请 ${rl.retryAfterSec} 秒后再试` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    )
  }

  // ── 执行回填 ──
  const stats = await runBackfill(supabase, userId)

  // ── 回填完自动触发一次 full build ──
  const buildResult = await runBuild(supabase, userId, 'full')

  return NextResponse.json({
    backfill: stats,
    build: buildResult,
  })
}
