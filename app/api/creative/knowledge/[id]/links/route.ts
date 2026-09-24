// ============================================================
// GET    /api/creative/knowledge/[id]/links —— 这条知识被哪些作品用过
// POST   /api/creative/knowledge/[id]/links —— 手动关联一个作品 { projectId }
// DELETE /api/creative/knowledge/[id]/links?projectId=xxx —— 取消关联
//
// 归属校验的两道闸（缺一不可）：
//   1. 知识单元必须是自己的：否则可以拿着任意 knowledge_id 去关联别人的作品，
//      把"某某作品用过这条知识"这种判断污染进别人的知识库视图
//   2. 作品必须是自己的：两侧都确认后才写一行纯 id 关系
//   —— 本表没有 user_id 之外的约束能替我们做这件事，所以必须显式查。
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import { loadLinkedWorks } from '@/lib/creative/knowledgeLink'

export const dynamic = 'force-dynamic'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function migrationResponse() {
  return NextResponse.json(
    {
      error:
        '知识关联表尚未初始化，请先执行 supabase/migrations/0011_knowledge_work_links.sql',
      needsMigration: true,
    },
    { status: 503 }
  )
}

function isMissingMigration(error: unknown): boolean {
  const code = (error as { code?: string } | null | undefined)?.code
  return code === '42P01' || code === '42883' || code === 'PGRST202'
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: '无效的知识单元 ID' }, { status: 400 })
  }

  const token = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: '未登录' }, { status: 401 })
  const supabase = createServerClient(token)
  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) return authFailureResponse(authErr)
  const userId = userData.user.id

  // 知识单元归属先确认：不存在的单元返回 404，而不是空数组（前端要能区分"没有/没有权限"）
  const { data: unit, error: unitErr } = await supabase
    .from('creator_knowledge')
    .select('id')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()

  if (unitErr) {
    if ((unitErr as { code?: string }).code === '42P01') {
      return NextResponse.json(
        { error: '知识单元表尚未初始化，请先执行 supabase/migrations/0005_creator_knowledge.sql' },
        { status: 503 }
      )
    }
    console.error('knowledge-links: 知识单元查询失败:', unitErr.message)
    return NextResponse.json({ error: '查询失败' }, { status: 500 })
  }
  if (!unit) return NextResponse.json({ error: '知识单元不存在' }, { status: 404 })

  const result = await loadLinkedWorks(supabase, userId, [id])
  if (!result.ok) {
    if (result.reason === 'missing-migration') return migrationResponse()
    console.error('knowledge-links: 关联查询失败:', result.message)
    return NextResponse.json({ error: '关联查询失败' }, { status: 500 })
  }

  return NextResponse.json({ links: result.links[id] ?? [] })
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: '无效的知识单元 ID' }, { status: 400 })
  }

  const token = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: '未登录' }, { status: 401 })
  const supabase = createServerClient(token)
  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) return authFailureResponse(authErr)
  const userId = userData.user.id

  const body = (await req.json().catch(() => null)) as { projectId?: unknown } | null
  const projectId = typeof body?.projectId === 'string' ? body.projectId : ''
  if (!UUID_PATTERN.test(projectId)) {
    return NextResponse.json({ error: '无效的作品 ID' }, { status: 400 })
  }

  // 两侧归属校验
  const [{ data: unit, error: unitErr }, { data: project, error: projErr }] =
    await Promise.all([
      supabase.from('creator_knowledge').select('id').eq('id', id).eq('user_id', userId).maybeSingle(),
      supabase
        .from('creative_projects')
        .select('id')
        .eq('id', projectId)
        .eq('user_id', userId)
        .maybeSingle(),
    ])

  if (unitErr || projErr) {
    const err = unitErr ?? projErr
    if (isMissingMigration(err)) return migrationResponse()
    console.error('knowledge-links: 归属校验失败:', err?.message)
    return NextResponse.json({ error: '校验失败' }, { status: 500 })
  }
  if (!unit) return NextResponse.json({ error: '知识单元不存在' }, { status: 404 })
  if (!project) return NextResponse.json({ error: '作品不存在' }, { status: 404 })

  const { error } = await supabase.from('creator_knowledge_links').upsert(
    {
      user_id: userId,
      knowledge_id: id,
      project_id: projectId,
      origin: 'manual',
    },
    { onConflict: 'knowledge_id,project_id', ignoreDuplicates: true }
  )

  if (error) {
    if (isMissingMigration(error)) return migrationResponse()
    console.error('knowledge-links: 写入失败:', error.message)
    return NextResponse.json({ error: '关联失败' }, { status: 500 })
  }

  const result = await loadLinkedWorks(supabase, userId, [id])
  return NextResponse.json({
    ok: true,
    links: result.ok ? result.links[id] ?? [] : [],
  })
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: '无效的知识单元 ID' }, { status: 400 })
  }

  const token = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: '未登录' }, { status: 401 })
  const supabase = createServerClient(token)
  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) return authFailureResponse(authErr)
  const userId = userData.user.id

  const projectId = new URL(req.url).searchParams.get('projectId') ?? ''
  if (!UUID_PATTERN.test(projectId)) {
    return NextResponse.json({ error: '无效的作品 ID' }, { status: 400 })
  }

  const { error } = await supabase
    .from('creator_knowledge_links')
    .delete()
    .eq('user_id', userId)
    .eq('knowledge_id', id)
    .eq('project_id', projectId)

  if (error) {
    if (isMissingMigration(error)) return migrationResponse()
    console.error('knowledge-links: 删除失败:', error.message)
    return NextResponse.json({ error: '取消关联失败' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
