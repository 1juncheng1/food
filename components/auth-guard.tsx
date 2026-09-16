'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuth } from '@/components/auth-provider'

// ────────────────────────────────────────────────────────────
// 鉴权守卫：(main) 路由组的统一前端鉴权
// 未登录时跳转 /login，鉴权期间显示加载态，避免页面内容闪现
//
// 白名单路径（PUBLIC_PATHS）：未登录也可访问，不触发跳转。
//   例如 /generate：灵感场支持游客用"灵感模式"生成（localStorage 存储），
//   这是新用户第一次感受到"AI 懂我"的关键转化入口，不设登录墙。
//   白名单页面内若涉及个人数据的功能（素材库/主页等）点击时仍会被各自的守卫拦到登录页。
// ────────────────────────────────────────────────────────────

/** 未登录即可访问的 (main) 路由前缀集合（精确匹配或前缀匹配） */
const PUBLIC_PATHS: ReadonlyArray<string> = [
  '/generate', // 灵感场生成页：游客可用灵感模式
]

function isPublicPath(pathname: string | null): boolean {
  if (!pathname) return false
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  const isPublic = isPublicPath(pathname)

  useEffect(() => {
    // 白名单路径：不做登录跳转
    if (isPublic) return
    if (!loading && !session) {
      router.replace('/login')
    }
  }, [loading, session, router, isPublic])

  // 鉴权中：显示加载骨架，不渲染子页面内容
  if (loading) {
    return (
      <div className="flex-1 ml-[220px] min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-zinc-600 text-sm">加载中…</div>
      </div>
    )
  }

  // 未登录且非白名单：不渲染页面内容（跳转由 useEffect 处理）
  if (!session && !isPublic) {
    return (
      <div className="flex-1 ml-[220px] min-h-screen flex items-center justify-center">
        <div className="text-zinc-600 text-sm">正在跳转登录…</div>
      </div>
    )
  }

  // 已登录，或白名单路径下的游客：正常渲染
  return <>{children}</>
}
