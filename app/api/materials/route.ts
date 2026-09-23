// ============================================================
// /api/materials
//
// GET：素材列表 + 分组过滤 + 类型过滤 + 模糊搜索
//   ?groupId=uuid     过滤指定分组
//   ?groupId=uncategorized  仅返回未分组素材（group_id IS NULL）
//   ?groupId=all 或不传 = 全部
//   ?type=观点/事实/...  过滤 material_type
//   ?q=关键词          content 模糊搜索（ilike）
//
// 鉴权：Bearer token → supabase.auth.getUser()
// 限流：30/min/用户
// 排序：created_at desc
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import { rateLimit } from '@/lib/rateLimit'
import { MATERIAL_TYPES } from '@/lib/creative/material'

export const maxDuration = 30

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

    // 限流：30/min/用户
    const rl = rateLimit(`materials-read:${user.id}`, 30, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    // ── 解析 query 参数 ────────────────────────────────────
    const { searchParams } = new URL(req.url)
    const groupId = searchParams.get('groupId') // null | 'all' | 'uncategorized' | uuid
    const type = searchParams.get('type') // null | MaterialType
    const q = searchParams.get('q') // null | 关键词

    // 校验 type 必须是 9 种枚举之一
    if (type && !MATERIAL_TYPES.includes(type as (typeof MATERIAL_TYPES)[number])) {
      return NextResponse.json(
        { error: '素材类型不合法' },
        { status: 400 }
      )
    }

    // 构建 query
    let query = supabase
      .from('scripts')
      .select(
        'id, content, created_at, type, file_url, category, knowledge, group_id, material_type, source, ai_summary, related_topics, updated_at'
      )

    // groupId 过滤
    if (groupId && groupId !== 'all') {
      if (groupId === 'uncategorized') {
        query = query.is('group_id', null)
      } else {
        query = query.eq('group_id', groupId)
      }
    }

    // type 过滤
    if (type) {
      query = query.eq('material_type', type)
    }

    // q 模糊搜索（转义 % _ 防注入）
    if (q) {
      const escaped = q.replace(/[%_\\]/g, '\\$&')
      query = query.ilike('content', `%${escaped}%`)
    }

    // 按 created_at desc 排序
    query = query.order('created_at', { ascending: false })

    const { data, error } = await query

    if (error) {
      console.error('查询素材列表失败:', error)
      return NextResponse.json(
        { error: '获取素材列表失败，请稍后再试' },
        { status: 500 }
      )
    }

    return NextResponse.json({ materials: data ?? [] })
  } catch (error) {
    console.error('materials API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
