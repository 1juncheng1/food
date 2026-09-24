// ============================================================
// POST /api/ci/backfill-embedding
// 一次性运维端点：给 ci_items 存量行补算语义向量（WFP1）。
//
// 鉴权：Bearer token（必须登录，匿名不得触发付费 embedding 调用）
// 限流：全局 1 次 / 10 分钟（这是跨用户共享表，按用户限流没有意义）
// 返回：{ scanned, embedded, failed, remaining }；remaining > 0 再调一次
// ============================================================

import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/apiAuth'
import { backfillCiEmbeddings } from '@/lib/ci/backfillEmbedding'
import { rateLimit } from '@/lib/rateLimit'

// 100 条 × bge-m3 串行，需放宽超时
export const maxDuration = 60
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const auth = await authenticateRequest(req)
  if (!auth.ok) return auth.response
  const { supabase } = auth

  // 全局限流：bge-m3 按条计费，且 ci_items 是共享表
  const rl = rateLimit('ci-embedding-backfill', 1, 10 * 60_000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: `回填过于频繁，请 ${rl.retryAfterSec} 秒后再试` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    )
  }

  const stats = await backfillCiEmbeddings(100)
  return NextResponse.json(stats)
}
