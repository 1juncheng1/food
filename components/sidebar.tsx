'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'
import {
  BookOpen,
  Coins,
  Compass,
  FolderOpen,
  Home,
  Layers,
  LogOut,
  PanelLeftClose,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  User,
  Wallet,
  Wand2,
  type LucideIcon,
} from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { useAuth } from '@/components/auth-provider'
import { useIsAdmin } from '@/hooks/use-is-admin'

// ────────────────────────────────────────────────────────────
// 左侧导航栏：固定 220px 宽，深色主题，底部用户信息 + 退出
// 图标统一使用 lucide-react（与全站一致），不再手写内联 SVG
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

type NavItem = {
  href: string
  label: string
  icon: LucideIcon
}

/** 导航项配置：按「创作」与「我」分组，避免长列表压迫感 */
const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: '创作',
    items: [
      { href: '/dashboard', label: '创作机会', icon: Sparkles },
      { href: '/generate', label: '生成作品', icon: Wand2 },
      { href: '/works', label: '作品档案', icon: FolderOpen },
      { href: '/knowledge', label: '知识库', icon: BookOpen },
      { href: '/materials', label: '我的素材', icon: Layers },
      { href: '/explore', label: '灵感广场', icon: Compass },
    ],
  },
  {
    title: '我',
    items: [
      { href: '/publish', label: '发布灵感', icon: Send },
      { href: '/profile/me', label: '我的主页', icon: User },
      { href: '/points', label: '我的积分', icon: Coins },
      { href: '/recharge', label: '积分充值', icon: Wallet },
      { href: '/settings', label: '设置', icon: Settings },
    ],
  },
]

/** 首页单独置于分组之外，保持视觉上的"回首页"权重 */
const HOME_ITEM: NavItem = { href: '/', label: '首页', icon: Home }

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const pathname = usePathname()
  const router = useRouter()
  const { session } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)
  // 管理员才展示后台入口（真正的权限校验在服务端，这里只是可见性）
  const isAdmin = useIsAdmin(!!session)

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

  /** 单个导航项 */
  function renderItem(item: NavItem) {
    const active = isActive(item.href)
    const Icon = item.icon
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
          <Icon size={18} strokeWidth={1.8} />
        </span>
        {!collapsed && <span>{item.label}</span>}
      </Link>
    )
  }

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
          {!collapsed && <img src="/logo-text.png" alt="视界" className="block logo-text" />}
        </Link>
        <button
          onClick={onToggle}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          className="w-9 h-full flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition shrink-0 border-l border-zinc-800/60"
        >
          <PanelLeftClose
            size={16}
            strokeWidth={1.8}
            className={`transition-transform duration-300 ${collapsed ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {/* ── 导航项 ── */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {renderItem(HOME_ITEM)}

        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="mt-3">
            {!collapsed && (
              <p className="mb-1 px-3 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-600">
                {group.title}
              </p>
            )}
            {collapsed && <div className="vs-divider mx-2 mb-2" />}
            {group.items.map(renderItem)}
          </div>
        ))}

        {/* ── 管理后台：仅管理员可见（权限校验在服务端 requireAdmin）── */}
        {isAdmin && (
          <div className="mt-3">
            {!collapsed && (
              <p className="mb-1 px-3 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-600">
                管理
              </p>
            )}
            {collapsed && <div className="vs-divider mx-2 mb-2" />}
            {renderItem({ href: '/admin/recharge', label: '充值订单', icon: ShieldCheck })}
            {renderItem({ href: '/admin/points', label: '积分管理', icon: Wallet })}
          </div>
        )}
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
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            title="退出登录"
            className={`${
              collapsed
                ? 'absolute bottom-3 left-0 right-0 mx-auto w-8 h-8 flex items-center justify-center'
                : 'shrink-0'
            } text-zinc-500 hover:text-red-400 transition disabled:opacity-40`}
          >
            <LogOut size={collapsed ? 16 : 18} strokeWidth={1.8} />
          </button>
        </div>
      </div>
    </aside>
  )
}
