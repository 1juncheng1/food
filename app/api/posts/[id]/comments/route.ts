import { NextResponse } from 'next/server'
import {
  authenticateWithToken,
  extractBearerToken,
} from '@/lib/storage'
import { invalidatePostsBaseCache } from '@/lib/postsCache'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

/** 安全取字符串并截断 */
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** 评论数据结构（含回填的作者名/头像） */
interface Comment {
  id: string
  post_id: string
  user_id: string
  content: string
  created_at: string
  author_name: string
  author_avatar_url: string | null
}

/** POST 请求体 */
interface CommentBody {
  content?: unknown
}

// ────────────────────────────────────────────────────────────
// GET /api/posts/[id]/comments：获取该帖子的所有评论（join 用户邮箱前缀）
// 使用 RPC get_post_comments 获取带作者信息的评论列表
// ────────────────────────────────────────────────────────────
export async function GET(
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
    const { supabase } = auth

    const { id: postId } = await params
    const pid = str(postId, 100)
    if (!pid) {
      return NextResponse.json({ error: '无效的帖子 ID' }, { status: 400 })
    }

    // 调用 RPC 获取带作者信息的评论
    const { data, error } = await supabase.rpc('get_post_comments', {
      p_post_id: pid,
    })

    if (error) {
      console.error('获取评论失败:', error)
      // 服务端日志保留细节；数据库报错可能含表名/策略名，不能回显给客户端
      return NextResponse.json({ error: '获取评论失败' }, { status: 500 })
    }

    return NextResponse.json({ comments: data ?? [] })
  } catch (error) {
    console.error('comments GET 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

// ────────────────────────────────────────────────────────────
// POST /api/posts/[id]/comments：发表评论
// 插入 comments 表 + 更新 posts.comment_count
// ────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────
// DELETE /api/posts/[id]/comments?commentId=xxx：删除**自己的**评论
// 只能删自己发的（帖子作者删他人评论属于管理动作，本阶段不做）
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
    const commentId = str(new URL(req.url).searchParams.get('commentId'), 100)
    if (!pid || !commentId) {
      return NextResponse.json({ error: '参数不完整' }, { status: 400 })
    }

    // 先确认归属：不存在与「不是自己的」必须分开回（404 / 403），
    // 否则用户会看到"删除失败"却不知道为什么
    const { data: row, error: findErr } = await supabase
      .from('comments')
      .select('id, user_id, post_id')
      .eq('id', commentId)
      .eq('post_id', pid)
      .maybeSingle()

    if (findErr) {
      console.error('查询评论失败:', findErr)
      return NextResponse.json({ error: '删除失败，请稍后重试' }, { status: 500 })
    }
    if (!row) {
      return NextResponse.json({ error: '评论不存在或已被删除' }, { status: 404 })
    }
    if (row.user_id !== userId) {
      return NextResponse.json({ error: '只能删除自己的评论' }, { status: 403 })
    }

    const { error: delErr } = await supabase
      .from('comments')
      .delete()
      .eq('id', commentId)
      .eq('user_id', userId)

    if (delErr) {
      console.error('删除评论失败:', delErr)
      return NextResponse.json({ error: '删除失败，请稍后重试' }, { status: 500 })
    }

    // 计数回退（decrement_post_count 已做 greatest(0, ...) 保护）
    const { error: decErr } = await supabase.rpc('decrement_post_count', {
      p_post_id: pid,
      p_column: 'comment_count',
    })
    if (decErr) {
      console.error('回退评论计数失败:', decErr)
    }

    invalidatePostsBaseCache()

    // 回最新计数，前端直接校正，不要自己 -1（可能与别人的并发评论抵消）
    const { data: post } = await supabase
      .from('posts')
      .select('comment_count')
      .eq('id', pid)
      .maybeSingle()

    return NextResponse.json({
      success: true,
      commentCount: post?.comment_count ?? 0,
    })
  } catch (error) {
    console.error('comments DELETE 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

export async function POST(
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

    const body = (await req.json()) as CommentBody
    const content = str(body.content, 2000)
    if (!content) {
      return NextResponse.json({ error: '评论内容不能为空' }, { status: 400 })
    }

    // 插入评论
    const { data: comment, error: insertErr } = await supabase
      .from('comments')
      .insert({
        post_id: pid,
        user_id: userId,
        content,
      })
      .select('id, post_id, user_id, content, created_at')
      .single()

    if (insertErr) {
      console.error('插入评论失败:', insertErr)
      return NextResponse.json({ error: '发表评论失败' }, { status: 500 })
    }

    // 增加评论计数
    const { error: incErr } = await supabase.rpc('increment_post_count', {
      p_post_id: pid,
      p_column: 'comment_count',
    })
    if (incErr) {
      console.error('增加评论计数失败:', incErr)
    }

    // 公共列表缓存含 comment_count，必须失效，否则刷新后看到旧计数
    invalidatePostsBaseCache()

    // 回填作者名/头像：客户端读不到 auth.users，走 SECURITY DEFINER 函数。
    // 0008 迁移未执行时函数不存在 → 降级为空串，前端用 session 昵称兜底。
    const [{ data: displayName }, { data: avatarUrl }] = await Promise.all([
      supabase.rpc('user_display_name', { p_user_id: userId }),
      supabase.rpc('user_avatar_url', { p_user_id: userId }),
    ])

    const result: Comment = {
      id: comment.id,
      post_id: comment.post_id,
      user_id: comment.user_id,
      content: comment.content,
      created_at: comment.created_at,
      author_name: typeof displayName === 'string' ? displayName : '',
      author_avatar_url: typeof avatarUrl === 'string' ? avatarUrl : null,
    }

    return NextResponse.json({ comment: result })
  } catch (error) {
    console.error('comments POST 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
