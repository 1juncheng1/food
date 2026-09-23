// ============================================================
// GET /api/creative/knowledge
// 列出知识单元（候选 / 已确认 / 已拒绝 / 已过期）
// query: status —— 不传返回全部；source_count 用于前端判断素材支撑强度
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import {
  isKnowledgeStatus,
  normalizeKnowledgeUnit,
} from '@/lib/creative/knowledgeUnit'

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
      return NextResponse.json(
        { error: '知识单元表尚未初始化，请先执行 supabase/migrations/0005_creator_knowledge.sql' },
        { status: 503 }
      )
    }
    console.error('knowledge-list: 查询失败:', error.message)
    return NextResponse.json({ error: '知识单元查询失败' }, { status: 500 })
  }

  const units = (rows ?? [])
    .map(normalizeKnowledgeUnit)
    .filter((u): u is NonNullable<typeof u> => u !== null)

  return NextResponse.json({ units, total: units.length })
}
