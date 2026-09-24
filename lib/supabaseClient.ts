import { createClient, type Session } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  // 环境变量缺失时尽早报错，避免出现难以排查的运行时问题
  throw new Error('缺少 Supabase 环境变量，请检查 .env.local 配置')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

/** 同一页面内正在进行中的刷新（跨调用点共享） */
let refreshInFlight: Promise<{ session: Session | null; error: unknown }> | null = null

/**
 * 判定 auth 错误是否为「凭证真的失效」。
 *
 * 只有这类错误才允许清掉本地会话、把用户送回登录页。
 * 网络不通、5xx、项目暂停等**可用性**问题一律不算——清掉会话后用户既登不上
 * （同一条网络还是不通）又回不去，陷入死结。
 */
export function isCredentialInvalid(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: string; status?: number; message?: string; code?: string }
  const msg = (e.message ?? '') + ' ' + (e.code ?? '')

  if (e.status === 401 || e.status === 403) return true
  if (/invalid jwt|jwt expired|token expired|refresh_token_not_found|invalid refresh token|user_not_found|session.*(not found|missing)|auth session missing/i.test(msg)) {
    return true
  }
  return false
}

/** 判定 auth 错误是否为传输层故障（请求压根没到服务端） */
export function isAuthTransportError(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: string; status?: number; message?: string }
  if (e.name === 'AuthRetryableFetchError') return true
  if (e.status === 0) return true
  return /fetch failed|failed to fetch|network|timeout|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(
    e.message ?? ''
  )
}

/**
 * 把 supabase auth 错误翻译成用户能看懂的中文。
 * 原始 message 常是 "Failed to fetch" / "fetch failed" 这类英文传输错误，
 * 直接展示会让用户以为账号出了问题。
 */
export function describeAuthError(error: unknown): string {
  if (isAuthTransportError(error)) return '网络异常，无法连接到服务器，请检查网络后重试'
  if (!error || typeof error !== 'object') return '操作失败，请稍后重试'
  const e = error as { message?: string }
  const msg = (e.message ?? '').trim()
  if (!msg) return '操作失败，请稍后重试'

  // 常见业务错误中文化
  if (/invalid login credentials/i.test(msg)) return '邮箱或密码错误'
  if (/email not confirmed/i.test(msg)) return '邮箱尚未验证，请先到邮箱完成验证'
  if (/user already registered/i.test(msg)) return '该邮箱已注册，请直接登录'
  if (/password should be at least/i.test(msg)) return '密码长度不足，请至少输入 6 位'
  if (/unable to validate email|invalid email/i.test(msg)) return '邮箱格式不正确'
  if (/over_email_send_rate_limit|email rate limit/i.test(msg)) return '邮件发送过于频繁，请稍后再试'
  if (/over_request_rate_limit/i.test(msg)) return '操作过于频繁，请稍后再试'
  return msg
}

/** 刷新结果：带 error，供调用方区分「刷新失败的原因」 */
export type RefreshOutcome = { session: Session | null; error: unknown }

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
/**
 * 刷新会话，并合并同一页面内的并发刷新请求。
 *
 * 为什么要合并：Supabase 默认开启 refresh token rotation —— 一次刷新成功后，
 * 旧的 refresh_token 立即作废。materials 页有 10 处 getValidSession() 调用点，
 * 列表类场景常常同时发起，若各自调一次 refreshSession()，先到的成功、
 * 其余全部拿到 "Invalid Refresh Token"。叠加旧逻辑「刷新失败即判未登录」，
 * 用户就会被整页踢回 /login。共享同一个 in-flight promise 后，
 * 并发调用方拿到的是同一个结果，互不作废。
 *
 * 返回 error 而非只返回 session：调用方必须知道「为什么失败」，
 * 才能区分「凭证真的失效」（可踢）与「网络抖动」（绝不能踢）。
 */
export function refreshSessionDetailed(): Promise<RefreshOutcome> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = supabase.auth
    .refreshSession()
    .then(({ data, error }) => ({ session: data?.session ?? null, error: error ?? null }))
    .catch((e: unknown) => ({ session: null, error: e }))
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

/** 只要 session 的便捷版本（内部复用 detailed，保证并发合并语义一致） */
export function refreshSessionOnce(): Promise<Session | null> {
  return refreshSessionDetailed().then((r) => r.session)
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
