// ============================================================
// lib/adminAuth —— 管理员接口的唯一闸门（Phase 3）
//
// 这一层存在的理由只有一条：
//   **积分是钱**。任何能增加积分的接口都必须先证明"调用者是管理员"。
//
// 分两步验证，缺一不可：
//   1. 身份：Bearer token → supabase.auth.getUser()（lib/apiAuth，网络故障走 503）
//   2. 权限：admin_users 白名单表里有这个人
//
// 为什么权限查数据库而不是读 env 里的管理员邮箱：
//   改 env 要重新部署，且无法回答"谁在什么时候把谁设成了管理员"。
//   白名单表是运营数据，也才能被后台页面管理。
//
// 另外：**管理员身份校验通过后，写操作仍然只走 service_role**。
//   确认到账这类 RPC 在函数内还会再查一次 is_service_caller()，
//   所以即便将来有人绕过 Node 层直接打 RPC，也进不去。
// ============================================================

import { NextResponse } from 'next/server'
import { authenticateRequest, type AuthOk } from '@/lib/apiAuth'
import { getServiceClient } from '@/lib/ci/store'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

export type AdminResult =
  | { ok: true; auth: AuthOk }
  | { ok: false; response: NextResponse }

/**
 * 校验「当前请求者是管理员」。
 * 失败时返回可直接 return 的响应：401 未登录 / 403 不是管理员 / 503 网络故障。
 */
export async function requireAdmin(req: Request): Promise<AdminResult> {
  const auth = await authenticateRequest(req, '请先登录')
  if (!auth.ok) return { ok: false, response: auth.response }

  // 用用户自己的 token 查：RLS 只让人读自己那一行，
  // 所以这里能查到 === 这人是管理员，查不到 === 不是（或还没被加进白名单）
  const { data, error } = await auth.supabase
    .from('admin_users')
    .select('user_id')
    .eq('user_id', auth.userId)
    .maybeSingle()

  if (error) {
    console.error('[admin] 校验管理员身份失败:', error.message)
    return {
      ok: false,
      response: NextResponse.json(
        { error: '无法校验管理员权限，请稍后重试' },
        { status: 503, headers: NO_STORE }
      ),
    }
  }

  if (!data) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: '无权执行该操作（需要管理员权限）' },
        { status: 403, headers: NO_STORE }
      ),
    }
  }

  return { ok: true, auth }
}

/**
 * 取 service_role 客户端（写操作的唯一通道）。
 *
 * 未配置 SUPABASE_SERVICE_ROLE_KEY 时返回 500 —— 管理员写操作**不能降级**：
 * 静默失败会让管理员以为"确认成功了"而用户没收到积分，
 * 这比直接报错危险得多。
 */
export async function requireServiceClient(): Promise<
  { ok: true; db: NonNullable<ReturnType<typeof getServiceClient>> } | { ok: false; response: NextResponse }
> {
  const db = getServiceClient()
  if (!db) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: '服务端未配置 SUPABASE_SERVICE_ROLE_KEY，无法执行管理员操作' },
        { status: 500, headers: NO_STORE }
      ),
    }
  }
  return { ok: true, db }
}

/** 当前用户是不是管理员（给前端决定要不要展示后台入口） */
export async function isAdminUser(supabase: AuthOk['supabase'], userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('admin_users')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle()
  return !!data
}
