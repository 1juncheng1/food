// ============================================================
// GET /api/creative/knowledge
// 列出知识单元（候选 / 已确认 / 已拒绝 / 已过期）
// query:
//   status    —— 不传返回全部
//   withLinks —— =1 时随列表返回每条单元的关联作品（0011 起）
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import {
  isKnowledgeStatus,
  normalizeKnowledgeUnit,
} from '@/lib/creative/knowledgeUnit'
import { loadLinkedWorks, type LinkedWork } from '@/lib/creative/knowledgeLink'

export const dynamic = 'force-dynamic'

const MAX_ROWS = 200

export async function GET(req: Request) {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }
  const supabase = createServerClient(token)
  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return authFailureResponse(authErr)
  }
  const userId = userData.user.id

  const status = new URL(req.url).searchParams.get('status')
  if (status !== null && !isKnowledgeStatus(status)) {
    return NextResponse.json({ error: '无效的 status' }, { status: 400 })
  }

  let query = supabase
    .from('creator_knowledge')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(MAX_ROWS)

  if (status !== null) query = query.eq('status', status)

  const { data: rows, error } = await query

  if (error) {
    // 表尚未建：migration 0005 未执行时不要抛 500，给出可执行提示
    if ((error as { code?: string }).code === '42P01') {
      // needsMigration 是「这是迁移没跑」的唯一标记。
      // ⚠ 不能让前端只凭 HTTP 503 判断：鉴权层遇到网络故障时同样返回 503
      // （见 lib/apiAuth.ts 的 authFailureResponse），那时候表其实是好的，
      // 若按状态位判断就会把网络抖动谎报成"表没初始化"。
      return NextResponse.json(
        {
          error: '知识单元表尚未初始化，请先执行 supabase/migrations/0005_creator_knowledge.sql',
          needsMigration: true,
        },
        { status: 503 }
      )
    }
    console.error('knowledge-list: 查询失败:', error.message)
    return NextResponse.json({ error: '知识单元查询失败' }, { status: 500 })
  }

  const units = (rows ?? [])
    .map(normalizeKnowledgeUnit)
    .filter((u): u is NonNullable<typeof u> => u !== null)

  // ── 关联作品（0011 起）：列表页一次取完，避免 N 张卡片各发一个请求 ──
  // 关联是增强信息：取不到时把 linksAvailable 置 false 让前端收起这块 UI，
  // 绝不能让"关联表还没建"把整个知识列表变成 500。
  const withLinks = new URL(req.url).searchParams.get('withLinks') === '1'
  let links: Record<string, LinkedWork[]> | undefined
  let linksAvailable = true

  if (withLinks && units.length > 0) {
    const result = await loadLinkedWorks(
      supabase,
      userId,
      units.map((u) => u.id)
    )
    if (result.ok) {
      links = result.links
    } else {
      if (result.reason === 'error') {
        console.error('knowledge-list: 关联作品查询失败:', result.message)
      }
      linksAvailable = false
    }
  }

  return NextResponse.json({ units, total: units.length, links, linksAvailable })
}
