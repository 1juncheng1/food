// ============================================================
// /api/material-groups/[id]
//
// PATCH：重命名分组（重名返回 409；非本人分组返回 404）
// DELETE：先 update scripts.group_id=null（脱钩但不删素材）→ 再 delete group
//
// 鉴权：Bearer token → supabase.auth.getUser()
// 限流：写 10/min
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import { rateLimit } from '@/lib/rateLimit'

export const maxDuration = 30

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NAME_LENGTH = 30

async function authenticate(req: Request) {
  const authHeader = req.headers.get('authorization')
  const token = authHeader?.split(' ')[1]
  if (!token) {
    return { error: NextResponse.json({ error: '未登录' }, { status: 401 }) }
  }
  const supabase = createServerClient(token)
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser()
  if (userError || !user) {
    return { error: authFailureResponse(userError) }
  }
  return { supabase, user }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id || !UUID_PATTERN.test(id)) {
      return NextResponse.json({ error: '无效的分组 ID' }, { status: 400 })
    }

    const authResult = await authenticate(req)
    if ('error' in authResult) return authResult.error
    const { supabase, user } = authResult

    const rl = rateLimit(`material-groups-write:${user.id}`, 10, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    const body = await req.json()
    const rawName = body?.name
    if (typeof rawName !== 'string' || rawName.trim().length === 0) {
      return NextResponse.json({ error: '分组名不能为空' }, { status: 400 })
    }
    const name = rawName.trim()
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `分组名过长，最多 ${MAX_NAME_LENGTH} 字` },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from('material_groups')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id, name, created_at, updated_at')
      .single()

    if (error) {
      // 23505 = unique_violation（同用户下重名）
      if (error.code === '23505') {
        return NextResponse.json(
          { error: '分组名已存在，请换个名字' },
          { status: 409 }
        )
      }
      // PGRST116 = no rows found（非本人分组或分组不存在），RLS 兜底也走这里
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: '分组不存在' }, { status: 404 })
      }
      console.error('重命名分组失败:', error)
      return NextResponse.json(
        { error: '重命名失败，请稍后再试' },
        { status: 500 }
      )
    }

    return NextResponse.json({ group: data })
  } catch (error) {
    console.error('material-groups PATCH API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id || !UUID_PATTERN.test(id)) {
      return NextResponse.json({ error: '无效的分组 ID' }, { status: 400 })
    }

    const authResult = await authenticate(req)
    if ('error' in authResult) return authResult.error
    const { supabase, user } = authResult

    const rl = rateLimit(`material-groups-write:${user.id}`, 10, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    // 步骤 1：先把该分组下的素材 group_id 置 null（脱钩，不删素材）
    // RLS 自动限当前用户；显式加 user_id 更稳妥
    const { error: unlinkError } = await supabase
      .from('scripts')
      .update({ group_id: null, updated_at: new Date().toISOString() })
      .eq('group_id', id)
      .eq('user_id', user.id)

    if (unlinkError) {
      console.error('脱钩素材失败:', unlinkError)
      return NextResponse.json(
        { error: '删除分组失败，请稍后再试' },
        { status: 500 }
      )
    }

    // 步骤 2：删除分组（RLS 限 user_id；非本人分组删除会 0 行受影响）
    const { error: deleteError, count } = await supabase
      .from('material_groups')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('user_id', user.id)

    if (deleteError) {
      console.error('删除分组失败:', deleteError)
      return NextResponse.json(
        { error: '删除分组失败，请稍后再试' },
        { status: 500 }
      )
    }

    // count 为 0 表示分组不存在或非本人——返回 404
    if (count === 0) {
      return NextResponse.json({ error: '分组不存在' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('material-groups DELETE API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
