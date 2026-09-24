import { NextResponse } from 'next/server'
import {
  authenticateWithToken,
  extractBearerToken,
} from '@/lib/storage'
import { invalidatePostsBaseCache } from '@/lib/postsCache'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

// ────────────────────────────────────────────────────────────
// GET /api/posts/[id]：帖子详情（含创作档案）
// 走 get_post_detail RPC（security definer 内联作者名 + 互动态），仅公开帖
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
    if (!postId) {
      return NextResponse.json({ error: '无效的帖子 ID' }, { status: 400 })
    }

    const { data, error } = await supabase.rpc('get_post_detail', {
      p_post_id: postId,
    })

    if (error) {
      console.error('查询帖子详情失败:', error)
      return NextResponse.json(
        {
          error:
            '详情查询失败（若函数不存在，请执行 setup.sql 中 get_post_detail 迁移）',
        },
        { status: 500 }
      )
    }

    // RPC 返回单行或空集
    const row = Array.isArray(data) ? data[0] : data
    if (!row) {
      return NextResponse.json({ error: '帖子不存在或未公开' }, { status: 404 })
    }

    return NextResponse.json({ post: row })
  } catch (error) {
    console.error('get post detail API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

// ────────────────────────────────────────────────────────────
// DELETE /api/posts/[id]：删除自己的帖子
// 同时删除关联的图片文件（如有）
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
    if (!postId) {
      return NextResponse.json({ error: '无效的帖子 ID' }, { status: 400 })
    }

    // 先查出图片 URL（用于删除 Storage 文件）和帖子归属
    const { data: post, error: queryErr } = await supabase
      .from('posts')
      .select('id, user_id, image_url')
      .eq('id', postId)
      .maybeSingle()

    if (queryErr) {
      console.error('查询帖子失败:', queryErr)
      return NextResponse.json({ error: '删除失败' }, { status: 500 })
    }

    if (!post) {
      return NextResponse.json({ error: '帖子不存在' }, { status: 404 })
    }

    // 权限校验：只能删自己的帖子
    if (post.user_id !== userId) {
      return NextResponse.json({ error: '无权删除他人的帖子' }, { status: 403 })
    }

    // 删除帖子（关联的 comments 和 post_interactions 会级联删除）
    const { error: delErr } = await supabase
      .from('posts')
      .delete()
      .eq('id', postId)

    if (delErr) {
      console.error('删除帖子失败:', delErr)
      return NextResponse.json({ error: '删除失败' }, { status: 500 })
    }

    // 删除 Storage 中的图片文件（如有）
    if (post.image_url) {
      try {
        // 从完整 URL 中提取文件路径
        // URL 格式: https://xxx.supabase.co/storage/v1/object/public/media/{userId}/{timestamp}.ext
        const match = post.image_url.match(/\/media\/(.+)$/)
        if (match) {
          await supabase.storage.from('media').remove([match[1]])
        }
      } catch {
        // 图片清理失败不阻断删除流程
      }
    }

    // 已删的帖子不能继续出现在广场：失效公共列表缓存
    invalidatePostsBaseCache()

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('delete post API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
