// ============================================================
// /api/material-groups
//
// GET：列出当前用户全部分组（按 created_at desc）
// POST：创建分组（重名返回 409 中文友好错误）
//
// 鉴权：Bearer token → supabase.auth.getUser()
// 限流：读 30/min，写 10/min
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import { rateLimit } from '@/lib/rateLimit'

export const maxDuration = 30

const MAX_NAME_LENGTH = 30

export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.split(' ')[1]
    if (!token) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const supabase = createServerClient(token)

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser()
    if (userError || !user) {
      return authFailureResponse(userError)
    }

    const rl = rateLimit(`material-groups-read:${user.id}`, 30, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    const { data, error } = await supabase
      .from('material_groups')
      .select('id, name, created_at, updated_at')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('查询分组列表失败:', error)
      return NextResponse.json(
        { error: '获取分组列表失败，请稍后再试' },
        { status: 500 }
      )
    }

    return NextResponse.json({ groups: data ?? [] })
  } catch (error) {
    console.error('material-groups GET API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.split(' ')[1]
    if (!token) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const supabase = createServerClient(token)

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser()
    if (userError || !user) {
      return authFailureResponse(userError)
    }

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
      .insert({ user_id: user.id, name })
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
      console.error('创建分组失败:', error)
      return NextResponse.json(
        { error: '创建分组失败，请稍后再试' },
        { status: 500 }
      )
    }

    return NextResponse.json({ group: data })
  } catch (error) {
    console.error('material-groups POST API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
