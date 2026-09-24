// ============================================================
// POST /api/community/author-cards —— 批量取作者身份卡
//
// 设计要点：
//   1. 用 POST 而不是 GET：一屏 20 条帖子里去重后仍可能有十几个 id，
//      拼在 query string 里既不体面也容易被各处网关截断。
//   2. 底层一次 RPC 搞定（0010 迁移的 public.get_author_cards），
//      服务端内部 join auth.users / style_profiles / posts —— 客户端做不了这些。
//   3. 迁移没执行时不报错：返回 503 + 可执行提示，前端降级为"没有简介"，
//      广场照常能刷（作者身份是增强信息，不是主链路）。
// ============================================================

import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/apiAuth'
import { normalizeAuthorCard } from '@/lib/community/authorCard'

export const dynamic = 'force-dynamic'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_IDS = 60

/** 迁移未执行（RPC 不存在）时的提示：给可执行指令，而不是让前端对着 500 猜 */
const MIGRATION_HINT =
  '作者卡片 RPC 尚未初始化，请先执行 supabase/migrations/0010_author_cards.sql'

export async function POST(req: Request) {
  const auth = await authenticateRequest(req)
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const body = (await req.json().catch(() => null)) as { userIds?: unknown } | null
  const raw = Array.isArray(body?.userIds) ? body.userIds : []
  const userIds = Array.from(
    new Set(
      raw.filter((v): v is string => typeof v === 'string' && UUID_PATTERN.test(v))
    )
  ).slice(0, MAX_IDS)

  if (userIds.length === 0) {
    return NextResponse.json({ cards: [] })
  }

  const { data, error } = await supabase.rpc('get_author_cards', {
    p_user_ids: userIds,
  })

  if (error) {
    const code = (error as { code?: string }).code
    // 42883 = Postgres undefined_function；PGRST202 = PostgREST 找不到该函数。
    // 两者都是"迁移没跑"，与线上故障区分开。
    if (code === '42883' || code === 'PGRST202') {
      return NextResponse.json({ error: MIGRATION_HINT, needsMigration: true }, { status: 503 })
    }
    console.error('author-cards: 查询失败:', error.message)
    return NextResponse.json({ error: '作者信息查询失败' }, { status: 500 })
  }

  // jsonb 返回：supabase-js 已反序列化成数组；极个别情况下是单对象，统一成数组处理
  const rows = Array.isArray(data) ? data : data ? [data] : []
  const cards = rows
    .map(normalizeAuthorCard)
    .filter((c): c is NonNullable<typeof c> => c !== null)

  return NextResponse.json({ cards })
}
