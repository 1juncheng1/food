'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth-provider'

// ────────────────────────────────────────────────────────────
// 鉴权守卫：(main) 路由组的统一前端鉴权
// 未登录时跳转 /login，鉴权期间显示加载态，避免页面内容闪现
//
// 本路由组**不设白名单**：(main) 下每一个页面都是功能页，
// 未登录一律回 /login，登录入口统一放在首页（/）。
//
// 为什么一个口子都不留：游客态没有用户维度，会让积分计费、
// 素材归属、作品落库全部失去落点；而留着 /generate 这种"可浏览"页面，
// 等于把游客模式悄悄留在产品里——用户能看见按钮，却点不动。
// 后端 API 亦全部强制鉴权，前端拦不住时由 401 兜底。
// ────────────────────────────────────────────────────────────

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!loading && !session) {
      router.replace('/login')
    }
  }, [loading, session, router])

  // 鉴权中：显示加载态，不渲染子页面内容
  // 注意：外层 main 已按侧边栏宽度设置 margin，这里不要再加 ml，否则内容会被推偏
  if (loading) {
    return (
      <div className="w-full min-h-screen flex items-center justify-center">
        <div className="flex items-center gap-2.5 text-[13px] text-indigo-200/90">
          <span className="inline-flex items-center gap-[3px]">
            <i className="vs-ai-dot" />
            <i className="vs-ai-dot" />
            <i className="vs-ai-dot" />
          </span>
          <span>正在准备你的创作空间…</span>
        </div>
      </div>
    )
  }

  // 未登录：不渲染页面内容（跳转由 useEffect 处理）
  if (!session) {
    return (
      <div className="w-full min-h-screen flex items-center justify-center">
        <div className="text-zinc-500 text-sm">正在跳转登录…</div>
      </div>
    )
  }

  return <>{children}</>
}
