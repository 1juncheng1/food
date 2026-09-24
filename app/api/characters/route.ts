import { NextResponse } from 'next/server'
import {
  authenticateWithToken,
  extractBearerToken,
} from '@/lib/storage'

export const dynamic = 'force-dynamic'

// ────────────────────────────────────────────────────────────
// /api/characters：用户角色库 CRUD
//   GET  = 我的角色列表（按创建时间倒序）
//   POST = 新建角色（name 必填；self-draft 草稿经用户确认后也走这里落库）
// ────────────────────────────────────────────────────────────

const MAX_NAME = 30
const MAX_FIELD = 200

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : ''
}

export async function GET(req: Request) {
  try {
    const token = extractBearerToken(req)
    if (!token) return NextResponse.json({ error: '请先登录' }, { status: 401 })
    const auth = await authenticateWithToken(token)
    if (!auth.ok) return auth.response
    const { supabase, userId } = auth

    const { data, error } = await supabase
      .from('user_characters')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('读取角色库失败:', error)
      return NextResponse.json({ error: '读取角色失败' }, { status: 500 })
    }
    return NextResponse.json({ characters: data ?? [] })
  } catch (e) {
    console.error('characters GET 错误:', e)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const token = extractBearerToken(req)
    if (!token) return NextResponse.json({ error: '请先登录' }, { status: 401 })
    const auth = await authenticateWithToken(token)
    if (!auth.ok) return auth.response
    const { supabase, userId } = auth

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const name = clean(body?.name, MAX_NAME)
    if (!name) {
      return NextResponse.json({ error: '请填写角色名' }, { status: 400 })
    }

    const role =
      body?.role === 'protagonist' || body?.role === 'narrator' ? body.role : 'supporting'

    const { data, error } = await supabase
      .from('user_characters')
      .insert({
        user_id: userId,
        name,
        background: clean(body?.background, MAX_FIELD),
        personality: clean(body?.personality, MAX_FIELD),
        role,
        is_self: body?.isSelf === true,
      })
      .select()
      .single()

    if (error) {
      console.error('新建角色失败:', error)
      return NextResponse.json({ error: '保存角色失败' }, { status: 500 })
    }
    return NextResponse.json({ character: data }, { status: 201 })
  } catch (e) {
    console.error('characters POST 错误:', e)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
