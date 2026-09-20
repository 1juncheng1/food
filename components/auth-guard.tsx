'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuth } from '@/components/auth-provider'

// ────────────────────────────────────────────────────────────
// 鉴权守卫：(main) 路由组的统一前端鉴权
// 未登录时跳转 /login，鉴权期间显示加载态，避免页面内容闪现
//
// 白名单路径（PUBLIC_PATHS）：未登录也可访问，不触发跳转。
//   /generate：游客可浏览生成页了解产品，但点击生成入口时
//   弹出登录引导弹窗（LoginGate），不进入生成流程。
//   后端 API 全部强制鉴权，前端拦不住时 401 兜底。
// ────────────────────────────────────────────────────────────

/** 未登录即可访问的 (main) 路由前缀集合（精确匹配或前缀匹配） */
const PUBLIC_PATHS: ReadonlyArray<string> = [
  '/generate', // 灵感场生成页：游客可浏览，生成入口弹出登录引导
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
