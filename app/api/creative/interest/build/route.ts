// ============================================================
// POST /api/creative/interest/build
// 触发兴趣画像重建（incremental / full）
// 鉴权：Bearer token；限流：3 次/10 分钟（沿用 summarize 同口径）
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import { runBuild } from '@/lib/creative/interest/builder'
import { rateLimit } from '@/lib/rateLimit'

// full build 含原因分析/簇命名/探索方向多次串行 LLM 调用，需放宽超时
export const maxDuration = 60
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  // ── 鉴权 ──
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

  // ── 限流：3 次/10 分钟（full build 串行多次 LLM，窗口必须是 600_000ms 而非 600ms）──
  const rl = rateLimit(`interest-build:${userId}`, 3, 10 * 60_000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: `操作过于频繁，请 ${rl.retryAfterSec} 秒后再试` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    )
  }

  // ── 参数 ──
  const body = await req.json().catch(() => ({}))
  const mode: 'incremental' | 'full' = body.mode === 'full' ? 'full' : 'incremental'

  // ── 执行 ──
  const result = await runBuild(supabase, userId, mode)

  return NextResponse.json({
    build_id: result.buildId,
    status: result.status,
    cluster_count: result.clusterCount,
    event_count: result.eventCount,
  })
}
