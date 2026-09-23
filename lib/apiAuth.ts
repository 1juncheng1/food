// ============================================================
// lib/apiAuth.ts
// 统一把 supabase.auth.getUser() 的失败翻译成 HTTP 响应
//
// 为什么必须区分「传输故障」与「凭证真的失效」：
//   supabase-js 在 fetch 失败时**不抛异常**，而是把 AuthRetryableFetchError
//   （name='AuthRetryableFetchError', status=0, message='fetch failed'）
//   作为 error 返回。若一律映射成 401，一次网络抖动就会被前端判定为
//   「登录已过期」→ 踢回 /login。用户看到的就是：页面莫名其妙掉线，
//   回到登录页再点登录又 Failed to fetch —— 两个报错其实是同一个根因。
//
//   真正的凭证失效是 AuthApiError 且带明确 HTTP 状态码（实测 403 invalid JWT /
//   401 unauthorized），请求**到达了服务端**；而 status=0 意味着请求压根没出去。
//   这两种情况必须走不同分支，否则服务可用性问题会被伪装成鉴权问题。
// ============================================================

import { NextResponse } from 'next/server'

/** 网络类失败给用户的文案：明确指向网络，避免用户以为账号出问题 */
const NETWORK_ERROR_MSG = '网络异常，未能验证登录状态，请稍后重试'

/**
 * 判定 getUser 的 error 是否为传输层故障。
 *
 * 判据按可靠性排序：
 *   1. AuthRetryableFetchError —— supabase-js 专用于网络/重试类错误的类型
 *   2. status === 0 —— 请求没能到服务端（真实 JWT 失效会带 4xx 状态码）
 *   3. 错误信息含网络关键词 —— 兜底，覆盖 SDK 版本差异
 */
function isTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: string; status?: number; message?: string }

  if (e.name === 'AuthRetryableFetchError') return true
  if (e.status === 0) return true

  return /fetch failed|network|timeout|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(
    e.message ?? ''
  )
}

/**
 * getUser 失败时生成应直接 return 的响应。
 *
 * 只在「确实失败」的分支里调用（!user || error），因此永远返回一个响应。
 * - 传输故障 → 503 + retryable 标记：**故意不是 401**，前端不得据此踢掉登录态
 * - 凭证失效 → 401，此时才允许前端引导用户重新登录
 */
export function authFailureResponse(error: unknown): NextResponse {
  if (isTransportFailure(error)) {
    return NextResponse.json(
      { error: NETWORK_ERROR_MSG, retryable: true },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    )
  }
  return NextResponse.json(
    { error: '登录已过期，请重新登录' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } }
  )
}
