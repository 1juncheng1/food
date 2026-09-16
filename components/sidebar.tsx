'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { useAuth } from '@/components/auth-provider'

// ────────────────────────────────────────────────────────────
// 左侧导航栏：固定 220px 宽，深色主题，底部用户信息 + 退出
// ────────────────────────────────────────────────────────────

/** 视界品牌 Logo：引用 public/logo.png */
function LogoIcon({ size = 30 }: { size?: number }) {
  return (
    <img
      src="/logo.png"
      alt="视界 Logo"
      width={size}
      height={size}
      className="block shrink-0 logo-glow"
      style={{ imageRendering: 'auto' }}
    />
  )
}

/** 导航项配置：路径 + 图标 + 文字 */
const NAV_ITEMS = [
  {
    href: '/',
    label: '首页',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <path d="M9 22V12h6v10" />
      </svg>
    ),
  },
  {
    href: '/explore',
    label: '灵感广场',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M16 12l-4-4-4 4M12 8v8" />
      </svg>
    ),
  },
  {
    href: '/dashboard',
    label: '我的素材库',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6h16M4 12h16M4 18h10" />
      </svg>
    ),
  },
  {
    href: '/solutions',
    label: '问题历史',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
      </svg>
    ),
  },
  {
    href: '/generate',
    label: '生成作品',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
  },
  {
    href: '/publish',
    label: '发布灵感',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
      </svg>
    ),
  },
  {
    href: '/profile/me',
    label: '我的主页',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    href: '/settings',
    label: '设置',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
] as const

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const pathname = usePathname()
  const router = useRouter()
  const { session } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)

  // 从全局 AuthProvider 获取邮箱，响应 token 刷新和登录态变化
  const email = session?.user?.email ?? ''

  /** 判断当前导航项是否高亮：首页精确匹配，其余前缀匹配 */
  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/'
    // /profile/me 和 /profile/[userId] 互相匹配高亮
    if (href === '/profile/me')
      return pathname.startsWith('/profile')
    return pathname === href || pathname.startsWith(href + '/')
  }

  /** 退出登录 */
  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    await supabase.auth.signOut()
    router.push('/')
  }

  // 取邮箱首字母作为头像占位
  const initial = email ? email[0].toUpperCase() : 'X'

  return (
    <aside
      className={`fixed left-0 top-0 bottom-0 ${collapsed ? 'w-[60px]' : 'w-[220px]'} flex flex-col bg-zinc-950/85 backdrop-blur-xl border-r border-zinc-800/60 z-50 transition-all duration-300`}
    >
      {/* ── Logo + 折叠按钮 ── */}
      <div className="h-14 flex items-center border-b border-zinc-800/60">
        <Link
          href="/"
          title="视界 · 首页"
          className={`flex-1 flex items-center ${collapsed ? 'justify-center' : 'gap-2.5 px-4'} transition-all duration-300`}
        >
          <LogoIcon size={collapsed ? 40 : 40} />
          {!collapsed && (
            <span className="text-xl font-semibold text-white tracking-wide whitespace-nowrap leading-none">
              视界
            </span>
          )}
        </Link>
        <button
          onClick={onToggle}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          className="w-9 h-full flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition shrink-0 border-l border-zinc-800/60"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-300 ${collapsed ? 'rotate-180' : ''}`}
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      </div>

      {/* ── 导航项 ── */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={`flex items-center ${collapsed ? 'justify-center px-0' : 'gap-3 px-3'} py-2.5 rounded-lg text-sm transition mb-0.5 ${collapsed ? 'mx-auto w-10' : ''} ${
                active
                  ? 'bg-indigo-500/15 text-indigo-300 font-medium'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
              }`}
            >
              <span className={active ? 'text-indigo-400' : 'text-zinc-500'}>
                {item.icon}
              </span>
              {!collapsed && <span>{item.label}</span>}
            </Link>
          )
        })}
      </nav>

      {/* ── 底部：用户信息 + 退出 ── */}
      <div className="border-t border-zinc-800/60 p-3">
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-3'} px-2 py-2`}>
          <div className="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-sm font-medium shrink-0">
            {initial}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="text-xs text-zinc-400 truncate">{email || '未登录'}</p>
            </div>
          )}
          {!collapsed && (
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              title="退出登录"
              className="text-zinc-500 hover:text-red-400 transition shrink-0 disabled:opacity-40"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5M21 12H9" />
              </svg>
            </button>
          )}
          {collapsed && (
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              title="退出登录"
              className="absolute bottom-3 left-0 right-0 mx-auto w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-red-400 transition disabled:opacity-40"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5M21 12H9" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
