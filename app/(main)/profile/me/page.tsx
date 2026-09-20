'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

// ────────────────────────────────────────────────────────────
// /profile/me → 重定向到 /profile/{当前用户ID}
// 侧边栏"我的主页"链接用此路径，避免在客户端组件中硬编码 userId
// ────────────────────────────────────────────────────────────

export default function MeRedirectPage() {
  const router = useRouter()

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user?.id) {
        router.replace('/login')
        return
      }
      router.replace(`/profile/${session.user.id}`)
    })
  }, [router])

  return (
    <div className="inner-page gen-stage" data-mode="inspiration">
      <div className="inner-container">
        <div className="inner-empty">
          <p>正在跳转…</p>
        </div>
      </div>
    </div>
  )
}
