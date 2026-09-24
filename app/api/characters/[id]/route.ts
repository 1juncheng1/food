import { NextResponse } from 'next/server'
import {
  authenticateWithToken,
  extractBearerToken,
} from '@/lib/storage'

export const dynamic = 'force-dynamic'

// ────────────────────────────────────────────────────────────
// /api/characters/[id]：单个角色的更新与删除（RLS 兜底 owner-only）
//   PATCH  = 更新（只覆盖传入字段）
//   DELETE = 删除
// ────────────────────────────────────────────────────────────

const MAX_NAME = 30
const MAX_FIELD = 200

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : ''
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = extractBearerToken(req)
    if (!token) return NextResponse.json({ error: '请先登录' }, { status: 401 })
    const auth = await authenticateWithToken(token)
    if (!auth.ok) return auth.response
    const { supabase, userId } = auth
    const { id } = await params
    if (!id) return NextResponse.json({ error: '缺少角色 ID' }, { status: 400 })

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

    if (typeof body?.name === 'string') {
      const name = clean(body.name, MAX_NAME)
      if (!name) return NextResponse.json({ error: '角色名不能为空' }, { status: 400 })
      patch.name = name
    }
    if (typeof body?.background === 'string') patch.background = clean(body.background, MAX_FIELD)
    if (typeof body?.personality === 'string') patch.personality = clean(body.personality, MAX_FIELD)
    if (body?.role === 'protagonist' || body?.role === 'supporting' || body?.role === 'narrator') {
      patch.role = body.role
    }
    if (typeof body?.isSelf === 'boolean') patch.is_self = body.isSelf

    const { data, error } = await supabase
      .from('user_characters')
      .update(patch)
      .eq('id', id)
      .eq('user_id', userId) // 双保险：RLS 之外显式限定 owner
      .select()
      .maybeSingle()

    if (error) {
      console.error('更新角色失败:', error)
      return NextResponse.json({ error: '更新角色失败' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: '角色不存在' }, { status: 404 })
    return NextResponse.json({ character: data })
  } catch (e) {
    console.error('characters PATCH 错误:', e)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = extractBearerToken(req)
    if (!token) return NextResponse.json({ error: '请先登录' }, { status: 401 })
    const auth = await authenticateWithToken(token)
    if (!auth.ok) return auth.response
    const { supabase, userId } = auth
    const { id } = await params
    if (!id) return NextResponse.json({ error: '缺少角色 ID' }, { status: 400 })

    const { error, count } = await supabase
      .from('user_characters')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('user_id', userId)

    if (error) {
      console.error('删除角色失败:', error)
      return NextResponse.json({ error: '删除角色失败' }, { status: 500 })
    }
    if (!count) return NextResponse.json({ error: '角色不存在' }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('characters DELETE 错误:', e)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
