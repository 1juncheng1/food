'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, refreshSessionOnce, getValidSession } from '@/lib/supabaseClient'
import { setStorageOwner } from '@/lib/storageOwner'

type AuthContextType = {
  session: Session | null
  user: User | null
  loading: boolean
}

const AuthContext = createContext<AuthContextType>({
  session: null,
  user: null,
  loading: true,
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 初始加载：从 localStorage 恢复 session
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      // 会话验活：getSession 只读本地缓存，服务端已注销的僵尸 token 会造成
      // "UI 以为已登录、API 全部 401、灵感推荐静默降级为平台推荐"的假象。
      // getUser 走服务端校验；失效则只清本设备（scope:'local' 不误杀其他设备会话）。
      if (session) {
        const { error } = await supabase.auth.getUser()
        if (error) {
          // token 可能只是过期了（JWT 默认 1h 有效期），先尝试 refresh 而非直接 signOut。
          // 直接 signOut 会清 localStorage，与并发执行的 getValidSession() 竞态，
          // 导致页面级 API 拿到旧 token 请求 → 401 "用户验证失败"。
          // ① 网络不通时 getUser 同样失败，但那不等于会话失效。
          //    此时若往下走到 signOut 清掉本地会话，网络恢复后用户仍要重新登录（误踢）。
          const errText = typeof error === 'object' && 'message' in error
            ? String(error.message ?? '')
            : ''
          if (error instanceof TypeError || /fetch|network|timeout/i.test(errText)) {
            setStorageOwner(session.user.id)
            setSession(session)
            setLoading(false)
            return
          }

          // ② 复用与 getValidSession() 相同的那一次刷新：两者各自发起会互相作废
          //    对方的 refresh_token，并发时必有一方拿到 "Invalid Refresh Token"。
          const refreshed = await refreshSessionOnce()
          if (!refreshed) {
            // refresh 也失败（refresh token 被吊销/过期）→ 确实是僵尸 session，清除
            await supabase.auth.signOut({ scope: 'local' })
            setStorageOwner(null)
            setSession(null)
            setLoading(false)
            return
          }
          // refresh 成功 → 用新 session 继续（不 signOut）
          setStorageOwner(refreshed.user.id)
          setSession(refreshed)
          setLoading(false)
          return
        }
      }
      // 必须先于 setSession/setLoading：AuthGuard 放行渲染子页时，
      // 本地存储归属已就绪，子页读到的一定是当前用户的内容桶
      setStorageOwner(session?.user.id ?? null)
      setSession(session)
      setLoading(false)
    })

    // 监听登录状态变化（登录/退出/token 刷新）
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      // 切换账号：先切换本地存储归属，再更新会话（退出登录归 null，内容读写全短路）
      setStorageOwner(session?.user.id ?? null)
      setSession(session)
    })

    return () => subscription.unsubscribe()
  }, [])

  // ── Token 保鲜：在根部让 session 始终新鲜 ──
  //
  // 为什么不在调用点逐个修：getValidSession() 目前只在 add / materials / knowledge
  // 三处使用，其余调用点仍直接裸调 supabase.auth.getSession()——它只读 localStorage
  // 缓存、不做刷新（这个事实就写在 lib/supabaseClient.ts 的注释里）。SDK 自带的
  // autoRefreshToken 在标签页休眠、被浏览器节流或内部 tick 失败时并不保证执行，
  // 于是页面停留超过 JWT 有效期后，那些裸调点取到的就是过期 token → 401。
  //
  // 逐个替换几十处调用点会把 diff 改爆也容易漏；在根部保鲜则是一处改动覆盖全部：
  // session 一直是新的，无论谁去读它都不会读到过期值。
  useEffect(() => {
    if (!session) return

    let timer: ReturnType<typeof setTimeout> | null = null

    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer)
      // 对齐到「过期前 5 分钟」再醒，而不是无脑每分钟轮询。
      // getValidSession 内部另有 120 秒窗口兜底，这里只需保证它会被触发。
      const expiresAtMs = (session.expires_at ?? 0) * 1000
      const delay = Math.max(5_000, expiresAtMs - Date.now() - 300_000)
      timer = setTimeout(() => {
        void getValidSession()
      }, delay)
    }

    scheduleRefresh()

    // 切回标签页 / 窗口重新获焦时立即验活。
    // 「切到某个页面就 401」正是这个场景：离开期间错过了刷新窗口，
    // 回来时本地 session 已过期，而 UI 还停留在已登录状态。
    const revalidate = () => {
      void getValidSession()
      scheduleRefresh()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') revalidate()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', revalidate)

    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', revalidate)
    }
  }, [session])

  return (
    <AuthContext.Provider value={{ session, user: session?.user ?? null, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
