'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useAuth } from '@/components/auth-provider'
import { supabase } from '@/lib/supabaseClient'
import { cn } from '@/lib/utils'

// ────────────────────────────────────────────────────────────
// 首页顶部导航：Logo + 锚点导航 + 登录态区域
// 仅负责首页，内页仍使用 components/sidebar.tsx
//
// 未登录只给一个去处——登录页。功能页全部需登录，登录入口统一在首页；
// 再放一个"开始创作"按钮只会把人送进内页、被守卫弹回来。
// ────────────────────────────────────────────────────────────

const NAV_LINKS = [
  { href: '#growth', label: '成长路径' },
  { href: '#capabilities', label: '核心能力' },
  { href: '#workflow', label: '创作流程' },
  { href: '/explore', label: '灵感广场' },
]

export function HomeNav() {
  const { session, loading } = useAuth()
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  const isLoggedIn = !!session
  const email = session?.user?.email ?? ''
  const displayName = email ? email.split('@')[0] : ''
  const initial = displayName ? displayName[0].toUpperCase() : 'U'

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    setMenuOpen(false)
    await supabase.auth.signOut()
    router.push('/')
    router.refresh()
  }

  return (
    <header className="home-nav lp-nav">
      <Link href="/" className="flex items-center gap-2.5 shrink-0">
        <img src="/logo.png" alt="视界 Logo" width={36} height={36} className="block shrink-0 logo-glow" />
        <img src="/logo-text.png" alt="视界" className="block shrink-0 logo-text" />
      </Link>

      {/* 中部锚点导航：窄屏隐藏，靠 Hero 的按钮承担引导 */}
      <nav className="lp-nav-links" aria-label="首页导航">
        {NAV_LINKS.map((item) => (
          <Link key={item.href} href={item.href} className="lp-nav-link">
            {item.label}
          </Link>
        ))}
      </nav>

      {loading ? (
        <div className="w-24 h-7 rounded-lg bg-white/5 animate-pulse" />
      ) : isLoggedIn ? (
        <div className="relative shrink-0">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="w-7 h-7 rounded-full bg-[var(--vs-beam-wash)] text-[var(--vs-ink)] flex items-center justify-center text-xs font-medium">
              {initial}
            </span>
            <span className="text-sm text-[var(--vs-ink)] max-w-[120px] truncate">{displayName}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--vs-ink-3)]">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-2 w-48 bg-[var(--vs-void-1)] border border-[var(--vs-line)] rounded-lg shadow-xl py-1 z-50" role="menu">
                <Link href="/dashboard" className="block px-4 py-2.5 text-[14px] text-[var(--vs-ink-2)] hover:bg-[var(--vs-void-2)] hover:text-[var(--vs-ink)] transition" onClick={() => setMenuOpen(false)}>
                  进入工作台
                </Link>
                <Link href="/profile/me" className="block px-4 py-2.5 text-[14px] text-[var(--vs-ink-2)] hover:bg-[var(--vs-void-2)] hover:text-[var(--vs-ink)] transition" onClick={() => setMenuOpen(false)}>
                  我的主页
                </Link>
                <Link href="/settings" className="block px-4 py-2.5 text-[14px] text-[var(--vs-ink-2)] hover:bg-[var(--vs-void-2)] hover:text-[var(--vs-ink)] transition" onClick={() => setMenuOpen(false)}>
                  设置
                </Link>
                <div className="border-t border-[var(--vs-line)] my-1" />
                <button
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className="w-full text-left px-4 py-2.5 text-sm vs-error-text hover:bg-[var(--vs-void-2)] transition disabled:opacity-40"
                >
                  {loggingOut ? '退出中…' : '退出登录'}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 shrink-0">
          <Link href="/login" className={cn('lp-nav-cta')}>
            登录后开始创作
          </Link>
        </div>
      )}
    </header>
  )
}
