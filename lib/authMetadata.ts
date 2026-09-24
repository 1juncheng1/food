// ────────────────────────────────────────────────────────────
// 更新「当前登录用户自己」的 auth.users.raw_user_meta_data
// （display_name / avatar_url）—— 社区身份的唯一权威来源。
//
// 为什么走 GoTrue REST 而不是 SQL：
//   1. auth.users 是 Supabase 托管表，RLS 不允许直接用 SQL 改别人的行，
//      服务端也拿不到 service_role key（本项目只配了 anon + user token）；
//   2. GoTrue 的 PUT /auth/v1/user 是官方「用户改自己资料」的通道，
//      校验的是用户自己的 access_token，权限边界天然正确；
//   3. 避免了新建 profiles 表造成昵称/头像两份数据（冗余 + 不同步）。
// ────────────────────────────────────────────────────────────

const TIMEOUT_MS = 10_000

/** 可改的字段：只开放社区展示需要的两项 */
export type UserMetadataPatch = {
  display_name?: string
  avatar_url?: string | null
}

export type UpdateMetadataResult =
  | { ok: true; displayName: string; avatarUrl: string | null }
  | { ok: false; status: number; error: string }

/** 从 GoTrue 返回体里取一条中文错误文案（GoTrue 的字段名不统一，逐个兜底） */
function pickError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const p = payload as Record<string, unknown>
  for (const key of ['msg', 'message', 'error_description']) {
    const v = p[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  const err = p.error
  if (typeof err === 'string' && err.trim()) return err.trim()
  return ''
}

export async function updateOwnUserMetadata(
  token: string,
  patch: UserMetadataPatch
): Promise<UpdateMetadataResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    // 部署故障，不是用户的问题
    return { ok: false, status: 500, error: '服务未正确配置，请联系管理员' }
  }

  const res = await fetch(`${url}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: patch }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null)

  // fetch 抛错 = 请求没出去（网络/超时），绝不能当成「登录失效」
  if (!res) return { ok: false, status: 503, error: '网络异常，未能保存，请稍后重试' }

  if (!res.ok) {
    if (res.status === 401) {
      return { ok: false, status: 401, error: '登录已过期，请重新登录' }
    }
    const payload = await res.json().catch(() => null)
    return {
      ok: false,
      status: res.status === 422 ? 400 : 502,
      error: pickError(payload) || '资料更新失败，请稍后重试',
    }
  }

  const user = (await res.json().catch(() => null)) as
    | { user_metadata?: Record<string, unknown> }
    | null
  const meta = user?.user_metadata ?? {}
  const name = typeof meta.display_name === 'string' ? meta.display_name : ''
  const avatar = typeof meta.avatar_url === 'string' ? meta.avatar_url : null

  return { ok: true, displayName: name, avatarUrl: avatar && avatar.trim() ? avatar : null }
}

/** 安全的外链头像：只允许 http(s)，挡掉 javascript: / data: 等可被 XSS 利用的协议 */
export function isSafeAvatarUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (!s || s.length > 1000) return false
  return /^https?:\/\//i.test(s)
}
