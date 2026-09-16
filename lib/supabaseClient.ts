import { createClient, type Session } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  // 环境变量缺失时尽早报错，避免出现难以排查的运行时问题
  throw new Error('缺少 Supabase 环境变量，请检查 .env.local 配置')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

/**
 * 获取有效的登录会话。
 * getSession() 不会校验或刷新 token，页面停留超过 JWT 有效期后
 * 直接提交会 401，因此过期前 30 秒内先主动刷新。
 */
export async function getValidSession(): Promise<Session | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return null

  const expiresAtMs = (session.expires_at ?? 0) * 1000
  if (expiresAtMs - Date.now() < 30_000) {
    const { data } = await supabase.auth.refreshSession()
    return data.session ?? null
  }
  return session
}
