import { NextResponse } from 'next/server'
import {
  authenticateWithToken,
  extractBearerToken,
} from '@/lib/storage'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

// ────────────────────────────────────────────────────────────
// GET /api/profile/[userId]：获取用户个人主页数据
// 调用 get_user_profile RPC，返回风格卡 + 帖子 + 关注状态
// ────────────────────────────────────────────────────────────
export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string }> }
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

    const { userId } = await params
    if (!userId) {
      return NextResponse.json({ error: '缺少用户 ID' }, { status: 400 })
    }

    // 调用 RPC 获取完整个人主页数据
    const { data, error } = await supabase.rpc('get_user_profile', {
      p_target_user_id: userId,
    })

    if (error) {
      console.error('获取个人主页失败:', error)
      // 服务端日志保留细节；数据库报错可能含表名/策略名，不能回显给客户端
      return NextResponse.json({ error: '获取失败' }, { status: 500 })
    }

    // RPC 返回 jsonb，可能是对象或 JSON 字符串
    const result = typeof data === 'string' ? JSON.parse(data) : data
    if (!result?.success) {
      const code = typeof result?.code === 'number' ? result.code : 500
      return NextResponse.json({ error: result?.error ?? '获取失败' }, { status: code })
    }

    return NextResponse.json({ profile: result })
  } catch (error) {
    console.error('profile GET 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
