import { createClient, type Session } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  // 环境变量缺失时尽早报错，避免出现难以排查的运行时问题
  throw new Error('缺少 Supabase 环境变量，请检查 .env.local 配置')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

/** 同一页面内正在进行中的刷新（跨调用点共享） */
let refreshInFlight: Promise<Session | null> | null = null

/**
 * 刷新会话，并合并同一页面内的并发刷新请求。
 *
 * 为什么要合并：Supabase 默认开启 refresh token rotation —— 一次刷新成功后，
 * 旧的 refresh_token 立即作废。materials 页有 10 处 getValidSession() 调用点，
 * 列表类场景常常同时发起，若各自调一次 refreshSession()，先到的成功、
 * 其余全部拿到 "Invalid Refresh Token"。叠加旧逻辑「刷新失败即判未登录」，
 * 用户就会被整页踢回 /login。共享同一个 in-flight promise 后，
 * 并发调用方拿到的是同一个结果，互不作废。
 */
export function refreshSessionOnce(): Promise<Session | null> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = supabase.auth
    .refreshSession()
    .then(({ data }) => data.session ?? null)
    .catch(() => null)
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

/**
 * 获取有效的登录会话。
 * getSession() 不会校验或刷新 token，页面停留超过 JWT 有效期后
 * 直接提交会 401，因此过期前主动刷新。
 */
export async function getValidSession(): Promise<Session | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return null

  const expiresAtMs = (session.expires_at ?? 0) * 1000
  // 提前 120 秒刷新（而非 30 秒），给慢请求（如 /api/material-groups 偶尔 8s+）
  // 留足时间，避免 token 在请求飞行途中过期导致 401
  if (expiresAtMs - Date.now() >= 120_000) return session

  const refreshed = await refreshSessionOnce()
  if (refreshed) return refreshed

  // 刷新失败不等于会话失效：旧 token 在 expires_at 之前仍然可用。
  // 原先这里直接 return null，会把一次网络抖动或并发刷新冲突变成
  // 「用户没登录」——调用方普遍写成 if (!session) router.replace('/login')，
  // 于是用户被整页踢走。只有 token 确实已过期时才判 null。
  return Date.now() < expiresAtMs ? session : null
}
