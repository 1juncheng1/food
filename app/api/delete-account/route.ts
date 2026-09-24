import { NextResponse } from 'next/server'
import {
  authenticateWithToken,
  extractBearerToken,
} from '@/lib/storage'
import { getServiceClient } from '@/lib/ci/store'
import { rateLimit } from '@/lib/rateLimit'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

// ────────────────────────────────────────────────────────────
// POST /api/delete-account：永久注销账号
// 调用 auth.admin.deleteUser，数据库 on delete cascade 自动清理
// 所有关联表（scripts, posts, follows, style_profiles 等 14 张表）
//
// 破坏性不可逆操作，两道保护：
//   1. 限流 1 次/小时/用户
//   2. 密码二次确认 —— 仅凭 access_token 不足以注销。
//      token 泄漏（如 XSS）时，攻击者在不知道密码的情况下无法删除账号。
// ────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  try {
    const token = extractBearerToken(req)
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const auth = await authenticateWithToken(token)
    if (!auth.ok) return auth.response

    // ── 限流：不可逆操作，1 次/小时 ──
    const rl = rateLimit(`delete-account:${auth.userId}`, 1, 60 * 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `操作过于频繁，请 ${rl.retryAfterSec} 秒后再试` },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    // ── 密码二次确认 ──
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
    }
    const password = (body as { password?: unknown } | null)?.password
    if (typeof password !== 'string' || !password) {
      return NextResponse.json({ error: '请输入密码以确认注销' }, { status: 400 })
    }
    if (!auth.email) {
      // 理论上不会出现（本项目仅邮箱密码注册）；兜底拒绝而不是放行
      return NextResponse.json({ error: '无法校验身份，请联系管理员' }, { status: 400 })
    }
    const { error: reAuthErr } = await auth.supabase.auth.signInWithPassword({
      email: auth.email,
      password,
    })
    if (reAuthErr) {
      return NextResponse.json({ error: '密码错误，注销已取消' }, { status: 401 })
    }

    const admin = getServiceClient()
    if (!admin) {
      return NextResponse.json({ error: '服务配置错误，请联系管理员' }, { status: 500 })
    }

    const { error } = await admin.auth.admin.deleteUser(auth.userId)
    if (error) {
      console.error('注销账号失败:', error)
      return NextResponse.json({ error: '注销失败，请稍后重试' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: '服务器异常' }, { status: 500 })
  }
}
