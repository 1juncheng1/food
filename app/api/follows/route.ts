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

/** UUID 校验（小写十六进制 8-4-4-4-12） */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** POST/DELETE 请求体 */
interface FollowBody {
  followingId?: unknown
}

/**
 * 解析并校验请求体：JSON 解析失败返回 400 而不是落到外层 catch 变成 500，
 * 目标 ID 必须是合法 UUID（否则可写入任意字符串污染关注关系）。
 */
async function parseFollowBody(
  req: Request
): Promise<{ followingId: string } | { error: string }> {
  let raw: FollowBody
  try {
    raw = (await req.json()) as FollowBody
  } catch {
    return { error: '请求体不是合法 JSON' }
  }
  const followingId = str(raw.followingId, 100)
  if (!followingId) return { error: '缺少目标用户 ID' }
  if (!UUID_PATTERN.test(followingId)) return { error: '目标用户 ID 格式无效' }
  return { followingId }
}

// ────────────────────────────────────────────────────────────
// POST /api/follows：关注用户
// body: { followingId: string }
// ────────────────────────────────────────────────────────────
export async function POST(req: Request) {
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

    const body = await parseFollowBody(req)
    if ('error' in body) return NextResponse.json({ error: body.error }, { status: 400 })
    const followingId = body.followingId

    // 不能关注自己
    if (followingId === userId) {
      return NextResponse.json({ error: '不能关注自己' }, { status: 400 })
    }

    // 检查是否已关注（upsert 也能处理，但先查可以返回更友好的提示）
    const { data: existing } = await supabase
      .from('follows')
      .select('id')
      .eq('follower_id', userId)
      .eq('following_id', followingId)
      .maybeSingle()

    if (existing) {
      return NextResponse.json({ error: '已关注该用户', alreadyFollowing: true }, { status: 409 })
    }

    // 插入关注关系
    const { error: insertErr } = await supabase.from('follows').insert({
      follower_id: userId,
      following_id: followingId,
    })

    if (insertErr) {
      console.error('关注失败:', insertErr)
      return NextResponse.json({ error: '关注失败' }, { status: 500 })
    }

    return NextResponse.json({ success: true, action: 'followed' })
  } catch (error) {
    console.error('follows POST 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

// ────────────────────────────────────────────────────────────
// DELETE /api/follows：取消关注
// body: { followingId: string }
// ────────────────────────────────────────────────────────────
export async function DELETE(req: Request) {
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

    const body = await parseFollowBody(req)
    if ('error' in body) return NextResponse.json({ error: body.error }, { status: 400 })
    const followingId = body.followingId

    const { error: delErr } = await supabase
      .from('follows')
      .delete()
      .eq('follower_id', userId)
      .eq('following_id', followingId)

    if (delErr) {
      console.error('取消关注失败:', delErr)
      return NextResponse.json({ error: '取消关注失败' }, { status: 500 })
    }

    return NextResponse.json({ success: true, action: 'unfollowed' })
  } catch (error) {
    console.error('follows DELETE 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
