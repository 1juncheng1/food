import { NextResponse } from 'next/server'
import {
  authenticateWithToken,
  extractBearerToken,
} from '@/lib/storage'
import { trackEvent } from '@/lib/creative/interest/eventTracker'
import { invalidatePostsBaseCache } from '@/lib/postsCache'
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

/**
 * 读取帖子最新计数 + 当前用户的点赞/收藏态，供前端校正乐观更新。
 *
 * 两段查询各自容错：互动本身已经写成功了，读回状态失败不该把响应变成 500
 * （旧实现在这里炸掉会让用户看到"点赞失败"）。查不到就省略该字段，
 * 前端保留自己的乐观值。
 */
async function readPostState(
  supabase: Parameters<typeof trackEvent>[0],
  userId: string,
  postId: string
): Promise<Partial<{
  likeCount: number
  saveCount: number
  commentCount: number
  liked: boolean
  saved: boolean
}>> {
  const out: Partial<{
    likeCount: number
    saveCount: number
    commentCount: number
    liked: boolean
    saved: boolean
  }> = {}

  try {
    const { data: post } = await supabase
      .from('posts')
      .select('like_count, save_count, comment_count')
      .eq('id', postId)
      .maybeSingle()
    if (post) {
      out.likeCount = post.like_count ?? 0
      out.saveCount = post.save_count ?? 0
      out.commentCount = post.comment_count ?? 0
    }
  } catch (e) {
    console.error('读取帖子计数失败:', e)
  }

  try {
    const { data: rows } = await supabase
      .from('post_interactions')
      .select('interaction_type')
      .eq('user_id', userId)
      .eq('post_id', postId)
    const types = new Set(
      (rows ?? []).map((r: { interaction_type?: string }) => r.interaction_type)
    )
    out.liked = types.has('like')
    out.saved = types.has('save')
  } catch (e) {
    console.error('读取用户互动状态失败:', e)
  }

  return out
}

// ────────────────────────────────────────────────────────────
// POST /api/posts/[id]/interactions：点赞/收藏/风格共鸣 toggle
// 逻辑：已存在则删除（取消），不存在则插入（添加），同时更新 posts 计数
// 返回最新计数 + 最新 liked/saved，供前端校正乐观更新
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
    if (!auth.ok) return auth.response
    const { supabase, userId } = auth

    // ── 解析路径参数 ──
    const { id: postId } = await params
    const pid = str(postId, 100)
    if (!pid) {
      return NextResponse.json({ error: '无效的帖子 ID' }, { status: 400 })
    }

    // ── 解析请求体（JSON 非法应返回 400，而不是落到外层 catch 变成 500）──
    let body: InteractionBody
    try {
      body = (await req.json()) as InteractionBody
    } catch {
      return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
    }
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

      // 计数已变：公共列表缓存必须失效，否则刷新后拿到旧计数
      invalidatePostsBaseCache()

      const state = await readPostState(supabase, userId, pid)
      return NextResponse.json({
        action: 'removed',
        interactionType,
        ...state,
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
      // 并发双击 / 旧请求重放会撞 (user_id, post_id, type) 唯一约束（23505）。
      // 此时事实是「已点赞」，正确响应是回最新状态，而不是 500 —— 否则前端
      // 会把自己刚做的乐观更新回退掉，用户看到"点了又弹回去"。
      if (insertErr.code !== '23505') {
        console.error('插入互动记录失败:', insertErr)
        return NextResponse.json({ error: '操作失败' }, { status: 500 })
      }
      invalidatePostsBaseCache()
      const conflictState = await readPostState(supabase, userId, pid)
      return NextResponse.json({
        action: 'added',
        interactionType,
        ...conflictState,
      })
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

    // 计数已变：公共列表缓存必须失效，否则刷新后拿到旧计数
    invalidatePostsBaseCache()

    const state = await readPostState(supabase, userId, pid)
    return NextResponse.json({
      action: 'added',
      interactionType,
      ...state,
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
    if (!auth.ok) return auth.response
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

    invalidatePostsBaseCache()

    return NextResponse.json({ action: 'removed', interactionType })
  } catch (error) {
    console.error('interactions DELETE 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
