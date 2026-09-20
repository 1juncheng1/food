import { NextResponse } from 'next/server'
import {
  authenticateWithToken,
  extractBearerToken,
} from '@/lib/storage'
import { trackEvent } from '@/lib/creative/interest/eventTracker'
import type { CreatorEventType, TargetType } from '@/lib/creative/interest/types'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

/** 允许的互动类型 */
const VALID_TYPES = ['like', 'save', 'style_resonate'] as const
type InteractionType = (typeof VALID_TYPES)[number]

/** 互动类型 → posts 表计数列名映射 */
const COUNT_COLUMN: Record<InteractionType, 'like_count' | 'save_count'> = {
  like: 'like_count',
  save: 'save_count',
  // style_resonate 目前没有独立计数列，归入 like_count
  style_resonate: 'like_count',
}

/**
 * WF2：互动 → 创作者事件流映射（撤回对称负向）。
 * topic_search 契约（JSDoc 预留）：未来广场/素材库主题搜索框提交时，
 * 调 trackEvent({type:'topic_search', targetType:'topic', topicExcerpt:搜索词})，
 * weight 0.5 + autoEmbedding 自动补算向量。
 */
const EVENT_OF: Record<InteractionType, { added: CreatorEventType; removed: CreatorEventType }> = {
  like: { added: 'post_like', removed: 'post_unlike' },
  save: { added: 'post_save', removed: 'post_unsave' },
  style_resonate: { added: 'post_style_resonate', removed: 'post_unlike' }, // 无独立撤回枚举，降级同 like 撤回
}

/** POST 请求体 */
interface InteractionBody {
  interactionType?: unknown
}

/** 安全取字符串并截断 */
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/**
 * WF2：上报创作者事件（fire-and-forget，永不阻塞互动主响应）。
 * trackEvent 自身永不抛错；targetType=post 与创作项目无关（projectId=null）。
 */
function reportInteractionEvent(
  supabase: Parameters<typeof trackEvent>[0],
  userId: string,
  type: CreatorEventType,
  postId: string
): void {
  void trackEvent(supabase, userId, {
    type,
    targetType: 'post' as TargetType,
    targetId: postId,
    projectId: null,
    category: null,
    contentDomain: null,
  })
}

// ────────────────────────────────────────────────────────────
// POST /api/posts/[id]/interactions：点赞/收藏/风格共鸣 toggle
// 逻辑：已存在则删除（取消），不存在则插入（添加），同时更新 posts 计数
// ────────────────────────────────────────────────────────────
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // ── 鉴权 ──
    const token = extractBearerToken(req)
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const auth = await authenticateWithToken(token)
    if (!auth) {
      return NextResponse.json({ error: '登录已过期' }, { status: 401 })
    }
    const { supabase, userId } = auth

    // ── 解析路径参数 ──
    const { id: postId } = await params
    postId // 触发使用，避免 lint 警告
    const pid = str(postId, 100)
    if (!pid) {
      return NextResponse.json({ error: '无效的帖子 ID' }, { status: 400 })
    }

    // ── 解析请求体 ──
    const body = (await req.json()) as InteractionBody
    const interactionType = body.interactionType as InteractionType
    if (!VALID_TYPES.includes(interactionType)) {
      return NextResponse.json({ error: '无效的互动类型' }, { status: 400 })
    }

    // ── 检查是否已存在相同互动 ──
    const { data: existing, error: checkErr } = await supabase
      .from('post_interactions')
      .select('id')
      .eq('user_id', userId)
      .eq('post_id', pid)
      .eq('interaction_type', interactionType)
      .maybeSingle()

    if (checkErr) {
      console.error('查询互动记录失败:', checkErr)
      return NextResponse.json({ error: '操作失败' }, { status: 500 })
    }

    if (existing) {
      // ── 已存在：取消互动（删除记录 + 减少计数）──
      const { error: delErr } = await supabase
        .from('post_interactions')
        .delete()
        .eq('id', existing.id)

      if (delErr) {
        console.error('删除互动记录失败:', delErr)
        return NextResponse.json({ error: '取消互动失败' }, { status: 500 })
      }

      // 减少计数（使用 RPC 或直接 update，这里用直接 update + gt 过滤避免负数）
      const countCol = COUNT_COLUMN[interactionType]
      // 使用 RPC 执行原子减 1（避免并发覆盖）
      const { error: decErr } = await supabase.rpc('decrement_post_count', {
        p_post_id: pid,
        p_column: countCol,
      })
      if (decErr) {
        console.error('减少计数失败:', decErr)
        // 不阻断：计数偶尔不一致可接受，互动记录已删除
      }

      // WF2：撤回事件（对称负向，withdraw）
      reportInteractionEvent(supabase, userId, EVENT_OF[interactionType].removed, pid)

      // 查询最新计数返回
      const { data: post } = await supabase
        .from('posts')
        .select('like_count, save_count, comment_count')
        .eq('id', pid)
        .maybeSingle()

      return NextResponse.json({
        action: 'removed',
        interactionType,
        likeCount: post?.like_count ?? 0,
        saveCount: post?.save_count ?? 0,
        commentCount: post?.comment_count ?? 0,
      })
    }

    // ── 不存在：添加互动（插入记录 + 增加计数）──
    const { error: insertErr } = await supabase
      .from('post_interactions')
      .insert({
        user_id: userId,
        post_id: pid,
        interaction_type: interactionType,
      })

    if (insertErr) {
      // 可能是并发插入导致 unique 约束冲突，视为已存在
      console.error('插入互动记录失败:', insertErr)
      return NextResponse.json({ error: '操作失败' }, { status: 500 })
    }

    // 增加计数
    const countCol = COUNT_COLUMN[interactionType]
    const { error: incErr } = await supabase.rpc('increment_post_count', {
      p_post_id: pid,
      p_column: countCol,
    })
    if (incErr) {
      console.error('增加计数失败:', incErr)
    }

    // WF2：贡献事件（post_like 0.6 / post_save 1.5 / post_style_resonate 1.2）
    reportInteractionEvent(supabase, userId, EVENT_OF[interactionType].added, pid)

    // 查询最新计数返回
    const { data: post } = await supabase
      .from('posts')
      .select('like_count, save_count, comment_count')
      .eq('id', pid)
      .maybeSingle()

    return NextResponse.json({
      action: 'added',
      interactionType,
      likeCount: post?.like_count ?? 0,
      saveCount: post?.save_count ?? 0,
      commentCount: post?.comment_count ?? 0,
    })
  } catch (error) {
    console.error('interactions API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

// ────────────────────────────────────────────────────────────
// DELETE /api/posts/[id]/interactions：取消互动
// query string: ?type=like|save|style_resonate
// ────────────────────────────────────────────────────────────
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = extractBearerToken(req)
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const auth = await authenticateWithToken(token)
    if (!auth) {
      return NextResponse.json({ error: '登录已过期' }, { status: 401 })
    }
    const { supabase, userId } = auth

    const { id: postId } = await params
    const pid = str(postId, 100)
    if (!pid) {
      return NextResponse.json({ error: '无效的帖子 ID' }, { status: 400 })
    }

    // 从 query string 获取互动类型
    const url = new URL(req.url)
    const interactionType = str(url.searchParams.get('type'), 20) as InteractionType
    if (!VALID_TYPES.includes(interactionType)) {
      return NextResponse.json({ error: '无效的互动类型' }, { status: 400 })
    }

    // 删除互动记录
    const { error: delErr } = await supabase
      .from('post_interactions')
      .delete()
      .eq('user_id', userId)
      .eq('post_id', pid)
      .eq('interaction_type', interactionType)

    if (delErr) {
      console.error('删除互动记录失败:', delErr)
      return NextResponse.json({ error: '取消互动失败' }, { status: 500 })
    }

    // 减少计数
    const countCol = COUNT_COLUMN[interactionType]
    const { error: decErr } = await supabase.rpc('decrement_post_count', {
      p_post_id: pid,
      p_column: countCol,
    })
    if (decErr) {
      console.error('减少计数失败:', decErr)
    }

    // WF2：撤回事件（对称负向，withdraw）
    reportInteractionEvent(supabase, userId, EVENT_OF[interactionType].removed, pid)

    return NextResponse.json({ action: 'removed', interactionType })
  } catch (error) {
    console.error('interactions DELETE 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
