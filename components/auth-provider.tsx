'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabaseClient'
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
    supabase.auth.getSession().then(({ data: { session } }) => {
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

  return (
    <AuthContext.Provider value={{ session, user: session?.user ?? null, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
