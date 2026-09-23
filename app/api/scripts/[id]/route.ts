import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import { trackEvent } from '@/lib/creative/interest/eventTracker'
import { rateLimit } from '@/lib/rateLimit'
import { generateEmbedding } from '@/lib/storage'
import { MATERIAL_TYPES, type MaterialType } from '@/lib/creative/material'
import { normalizeKnowledgeItem } from '@/lib/creative/knowledgeItem'

export const maxDuration = 60

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_CONTENT_LENGTH = 10000

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    if (!id || !UUID_PATTERN.test(id)) {
      return NextResponse.json({ error: '无效的文案 ID' }, { status: 400 })
    }

    const authHeader = req.headers.get('authorization')
    const token = authHeader?.split(' ')[1]
    if (!token) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    // 走 createServerClient：服务端绝不参与 token 轮换，否则会作废浏览器端的
    // refresh_token，把用户踢成 "Invalid Refresh Token"（详见 lib/apiAuth.ts 说明）
    const supabase = createServerClient(token)

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser()

    if (userError || !user) {
      return authFailureResponse(userError)
    }

    // 显式限定 user_id，即使 RLS 配置有误也不会误删他人数据
    const { error: deleteError } = await supabase
      .from('scripts')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)

    if (deleteError) {
      console.error('删除错误:', deleteError)
      return NextResponse.json({ error: '删除失败，请稍后重试' }, { status: 500 })
    }

    // M1：素材删除 = 中性撤回（剔除该素材此前的画像贡献，不记负分）。
    // target_id 是文本无外键，脚本行删除后事件照常可入账。
    await trackEvent(supabase, user.id, {
      type: 'material_delete',
      targetType: 'script',
      targetId: id,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

// ============================================================
// PATCH /api/scripts/[id]
// body: { content?, materialType?, groupId?, source?, knowledge? }（至少一个字段）
//
// - knowledge：整块替换 scripts.knowledge jsonb，经 normalizeKnowledgeItem
//   白名单清洗（枚举/长度/类型）。用户只能改自己素材的 AI 理解，不能借它
//   注入任意结构。写入时同步刷新 analyzed_at —— 用户刚确认/纠正过的理解
//   就是最新理解，否则 isKnowledgeStale 会因为 updated_at 更新而误判为过期。
// - content 变化时重算 embedding（调 SiliconFlow bge-m3）；
//   失败不阻断——记 console.error + 返回 warning 字段 + 旧 embedding 保留
// - materialType 校验为 9 种枚举之一
// - groupId 校验归属当前用户（或 null=移出分组）
// - source 直接存（任意字符串）
// - 更新 updated_at = now()
// 限流：写 10/min
// ============================================================
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id || !UUID_PATTERN.test(id)) {
      return NextResponse.json({ error: '无效的文案 ID' }, { status: 400 })
    }

    const authHeader = req.headers.get('authorization')
    const token = authHeader?.split(' ')[1]
    if (!token) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    // 走 createServerClient：服务端绝不参与 token 轮换，否则会作废浏览器端的
    // refresh_token，把用户踢成 "Invalid Refresh Token"（详见 lib/apiAuth.ts 说明）
    const supabase = createServerClient(token)

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser()
    if (userError || !user) {
      return authFailureResponse(userError)
    }

    const rl = rateLimit(`scripts:${user.id}`, 10, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    const body = await req.json() ?? {}
    const { content, materialType, groupId, source, knowledge } = body

    // 至少一个字段
    if (
      content === undefined &&
      materialType === undefined &&
      groupId === undefined &&
      source === undefined &&
      knowledge === undefined
    ) {
      return NextResponse.json(
        { error: '请至少提供一项要修改的字段' },
        { status: 400 }
      )
    }

    // content 校验
    if (content !== undefined) {
      if (typeof content !== 'string' || content.trim().length === 0) {
        return NextResponse.json({ error: '内容不能为空' }, { status: 400 })
      }
      if (content.length > MAX_CONTENT_LENGTH) {
        return NextResponse.json(
          { error: `内容过长，最多 ${MAX_CONTENT_LENGTH} 字` },
          { status: 400 }
        )
      }
    }

    // materialType 校验：传了就必须是 9 种枚举之一
    if (
      materialType !== undefined &&
      !(MATERIAL_TYPES as readonly string[]).includes(materialType as string)
    ) {
      return NextResponse.json(
        { error: '素材类型不合法，请从 9 种类型中选择' },
        { status: 400 }
      )
    }

    // groupId 校验：传了非 null 值时必须归属当前用户（或 null=移出分组）
    if (groupId !== undefined && groupId !== null) {
      const { data: groupRow, error: groupError } = await supabase
        .from('material_groups')
        .select('id')
        .eq('id', groupId)
        .eq('user_id', user.id)
        .maybeSingle()
      if (groupError || !groupRow) {
        return NextResponse.json(
          { error: '所选分组不存在或无权访问' },
          { status: 400 }
        )
      }
    }

    // 先取旧素材，判断 content 是否真的变化（节省无效 embedding 调用）
    let oldContent: string | null = null
    if (content !== undefined) {
      const { data: oldRow, error: oldErr } = await supabase
        .from('scripts')
        .select('content')
        .eq('id', id)
        .eq('user_id', user.id)
        .maybeSingle()
      if (oldErr || !oldRow) {
        return NextResponse.json(
          { error: '素材不存在或无权访问' },
          { status: 404 }
        )
      }
      oldContent = oldRow.content
    }

    // knowledge 校验：整块替换，走与其他写入端一致的清洗白名单
    let cleanKnowledge: ReturnType<typeof normalizeKnowledgeItem> = null
    if (knowledge !== undefined) {
      cleanKnowledge = normalizeKnowledgeItem(knowledge)
      if (!cleanKnowledge) {
        return NextResponse.json(
          { error: 'AI 理解结构无效，请重新分析后再保存' },
          { status: 400 }
        )
      }
    }

    // 构建 update payload
    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }
    if (content !== undefined) {
      updatePayload.content = content.trim()
    }
    if (materialType !== undefined) {
      updatePayload.material_type = materialType as MaterialType
    }
    if (groupId !== undefined) {
      updatePayload.group_id = groupId // 含 null（移出分组）
    }
    if (source !== undefined) {
      updatePayload.source = typeof source === 'string' ? source : null
    }
    if (cleanKnowledge) {
      // analyzed_at 同步刷新：用户刚确认/纠正过的理解即最新理解，
      // 否则 materials 页的「AI 理解可能过时」会因 updated_at 更新而误报
      cleanKnowledge.analyzed_at = new Date().toISOString()
      updatePayload.knowledge = cleanKnowledge
    }

    // content 变化时重算 embedding（失败不阻断 + warning + 旧 embedding 保留）
    let warning: string | undefined
    if (content !== undefined && content.trim() !== oldContent) {
      try {
        const newEmbedding = await generateEmbedding(content.trim())
        if (newEmbedding) {
          updatePayload.embedding = newEmbedding
        } else {
          console.error('embedding 重算返回空')
          warning = '向量更新失败，检索可能不准'
        }
      } catch (e) {
        console.error('embedding 重算异常:', e)
        warning = '向量更新失败，检索可能不准'
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('scripts')
      .update(updatePayload)
      .eq('id', id)
      .eq('user_id', user.id)
      .select(
        'id, content, created_at, type, file_url, category, knowledge, group_id, material_type, source, ai_summary, related_topics, updated_at'
      )
      .single()

    if (updateError) {
      if (updateError.code === 'PGRST116') {
        return NextResponse.json(
          { error: '素材不存在或无权访问' },
          { status: 404 }
        )
      }
      console.error('更新素材失败:', updateError)
      return NextResponse.json(
        { error: '更新失败，请稍后再试' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      material: updated,
      ...(warning ? { warning } : {}),
    })
  } catch (error) {
    console.error('PATCH API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
