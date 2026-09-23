// ============================================================
// GET /api/creative/interest/profile
// 返回当前用户的兴趣画像（stale-while-revalidate）
// 画像过期时先返回旧画像（stale:true），客户端异步触发重建。
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import { getProfile } from '@/lib/creative/interest/interestRepo'
import { BUILD_MAX_AGE_HOURS } from '@/lib/creative/interest/config'

export async function GET(req: Request) {
  const authHeader = req.headers.get('Authorization')
  const token = authHeader?.replace('Bearer ', '')
  if (!token) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }
  const supabase = createServerClient(token)
  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return authFailureResponse(authErr)
  }
  const userId = userData.user.id

  const { profile, declaration } = await getProfile(supabase, userId)

  // 判断是否过期
  let stale = false
  if (profile && typeof profile === 'object') {
    const updatedAt = (profile as Record<string, unknown>).updated_at as string | undefined
    if (updatedAt) {
      const ageHrs = (Date.now() - Date.parse(updatedAt)) / 3_600_000
      stale = ageHrs > BUILD_MAX_AGE_HOURS
    }
  } else {
    // 无画像 = 完全冷启动
    stale = true
  }

  return NextResponse.json({
    profile: profile ?? {},
    declaration: declaration ?? {},
    stale,
    // 客户端收到 stale:true 时异步 POST /api/creative/interest/build
  })
}
