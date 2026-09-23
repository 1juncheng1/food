import { NextResponse } from 'next/server'
import {
  authenticateWithToken,
  extractBearerToken,
} from '@/lib/storage'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

/** 安全取字符串并截断 */
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** 评论数据结构 */
interface Comment {
  id: string
  post_id: string
  user_id: string
  content: string
  created_at: string
  author_name: string
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
    if (!auth) {
      return NextResponse.json({ error: '登录已过期' }, { status: 401 })
    }
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
    if (!auth) {
      return NextResponse.json({ error: '登录已过期' }, { status: 401 })
    }
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

    return NextResponse.json({
      comment: {
        ...comment,
        author_name: '', // 前端可从 session 补充，或忽略
      },
    })
  } catch (error) {
    console.error('comments POST 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
