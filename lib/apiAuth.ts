// ============================================================
// lib/apiAuth.ts
// 服务端鉴权的**唯一入口**：把 supabase.auth.getUser() 的各种失败
// 翻译成语义正确的 HTTP 响应
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
//
// 使用约定（所有 API 路由都应走这里，不要各自内联 getUser）：
//   const auth = await authenticateRequest(req)      // 或 authenticateToken(token)
//   if (!auth.ok) return auth.response               // 401=真·未登录/过期；503=网络故障
//   const { supabase, userId } = auth
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

/** 网络类失败给用户的文案：明确指向网络，避免用户以为账号出问题 */
const NETWORK_ERROR_MSG = '网络异常，未能验证登录状态，请稍后重试'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

/** 无 token（真的没登录）时的标准响应 */
export function unauthenticatedResponse(
  message = '请先登录'
): NextResponse {
  return NextResponse.json({ error: message }, { status: 401, headers: NO_STORE })
}

/**
 * 判定 getUser 的 error 是否为传输层故障。
 *
 * 判据按可靠性排序：
 *   1. AuthRetryableFetchError —— supabase-js 专用于网络/重试类错误的类型
 *   2. status === 0 —— 请求没能到服务端（真实 JWT 失效会带 4xx 状态码）
 *   3. 错误信息含网络关键词 —— 兜底，覆盖 SDK 版本差异
 */
export function isTransportFailure(error: unknown): boolean {
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
      { status: 503, headers: NO_STORE }
    )
  }
  return NextResponse.json(
    { error: '登录已过期，请重新登录' },
    { status: 401, headers: NO_STORE }
  )
}

/** 鉴权结果：成功带客户端与身份；失败带**可直接 return 的响应** */
export type AuthResult =
  | { ok: true; supabase: SupabaseClient; userId: string; email: string | null }
  | { ok: false; response: NextResponse }

/** 成功分支的类型（可选鉴权的路由需要把它存成变量） */
export type AuthOk = Extract<AuthResult, { ok: true }>

/** 从 Request 头里取出 Bearer token（无则空串） */
export function extractBearerToken(req: Request): string {
  const raw = req.headers.get('authorization') ?? ''
  return raw.startsWith('Bearer ') ? raw.slice(7).trim() : ''
}

/**
 * 用 access_token 验证身份。
 *
 * 三种结局各自独立，**不合并成 null**：
 *   - 无 token            → 401「请先登录」（真的没登录）
 *   - 网络/传输失败        → 503「网络异常」+ retryable（已登录用户不得被踢）
 *   - 凭证失效（JWT 过期） → 401「登录已过期」
 */
export async function authenticateToken(
  token: string,
  /** 无 token 时的自定义文案（如「请先登录后再生成方案」），默认「请先登录」 */
  noTokenMessage?: string
): Promise<AuthResult> {
  if (!token) return { ok: false, response: unauthenticatedResponse(noTokenMessage) }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) {
    // 环境变量缺失属于部署故障，不是用户的登录问题——不返回 401
    return {
      ok: false,
      response: NextResponse.json(
        { error: '服务未正确配置，请联系管理员', retryable: false },
        { status: 500, headers: NO_STORE }
      ),
    }
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token)

  if (error || !user) return { ok: false, response: authFailureResponse(error) }

  return { ok: true, supabase, userId: user.id, email: user.email ?? null }
}

/**
 * AI（LLM）调用失败时的统一响应。
 *
 * 用于「lib 函数只返回 null、拿不到原因」的老链路：优先用进程内最近一次
 * LLM 失败码给出准确文案（额度不足 / 超时 / 网络异常），拿不到再回落中性文案。
 *
 * 状态码：网络类 503（可用性问题，前端不得据此改动登录态），其余 502。
 */
export async function aiFailureResponse(neutralMessage: string): Promise<NextResponse> {
  const { isLlmNetworkError, llmUserMessage, recentLlmFailure } = await import('@/lib/llm')
  const code = recentLlmFailure()
  const status = isLlmNetworkError(code) ? 503 : 502
  return NextResponse.json(
    { error: code ? llmUserMessage(code) : neutralMessage, detail: code ?? undefined },
    { status, headers: NO_STORE }
  )
}

/** 从 Request 的 Authorization 头取 token 并验证身份（路由首选入口） */
export async function authenticateRequest(
  req: Request,
  noTokenMessage?: string
): Promise<AuthResult> {
  return authenticateToken(extractBearerToken(req), noTokenMessage)
}
