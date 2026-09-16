import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

/**
 * 服务端 Supabase 客户端（API 路由用）。
 *
 * 本项目 Supabase session 存在浏览器 localStorage（@supabase/supabase-js 默认行为），
 * 不走 cookie，所以服务端无法从 cookie 拿到身份。
 * 改为：前端把 access_token 放进 Authorization: Bearer <token> 请求头，
 * 服务端用该 token 调 auth.getUser() 验证身份并执行带用户上下文的数据库操作。
 *
 * @param accessToken 前端传来的 Supabase access_token（可为空，用于匿名访问）
 */
export function createServerClient(accessToken?: string) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : undefined,
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}
