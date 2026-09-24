// ============================================================
// POST /api/creative/knowledge/links-backfill
// 把历史版本的 used_knowledge 快照翻译成显式的「知识 ↔ 作品」关系
//
// 为什么需要这个动作：
//   0006 已经在每个生成版本里留下"这次用了哪些概念"，但那 snapshot 里没有知识单元 id，
//   于是老作品与知识库之间始终隔着一层文本匹配。用户在知识库点「确认」时，
//   看不到这条知识到底被哪些作品用过。
//   这个函数按 concept 把它们接起来，一次性让历史数据接上新结构 —— 不需要重跑任何生成。
//
// 幂等：底层 SQL 用 on conflict do nothing，重复点只会新增 0 条。
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: '未登录' }, { status: 401 })
  const supabase = createServerClient(token)
  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) return authFailureResponse(authErr)

  const { data, error } = await supabase.rpc('sync_knowledge_project_links', {
    p_user_id: userData.user.id,
  })

  if (error) {
    const code = (error as { code?: string }).code
    if (code === '42883' || code === 'PGRST202') {
      return NextResponse.json(
        {
          error:
            '回填函数尚未初始化，请先执行 supabase/migrations/0011_knowledge_work_links.sql',
          needsMigration: true,
        },
        { status: 503 }
      )
    }
    console.error('knowledge-links-backfill: 回填失败:', error.message)
    return NextResponse.json({ error: '回填失败' }, { status: 500 })
  }

  return NextResponse.json({ linked: Number(data) || 0 })
}
