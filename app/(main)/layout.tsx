import type { Metadata } from 'next'
import { SidebarLayout } from '@/components/sidebar-layout'
import { SITE_NAME_FULL } from '@/lib/seo'

// ────────────────────────────────────────────────────────────
// (main) 路由组布局：左侧固定导航栏 + 右侧内容区
// 路由组 (main) 不影响 URL，/dashboard 依然是 /dashboard
// SidebarLayout 为客户端组件，管理侧边栏折叠/展开状态并联动内容区 margin
// AuthGuard 在此层统一鉴权，未登录跳转 /login
// ────────────────────────────────────────────────────────────
//
// ── SEO ──
// 这一层的所有页面都需要登录（爬虫只能看到登录页空壳），
// 因此整个路由组统一 noindex + nofollow，robots.txt 里也已 Disallow。
// 各页面的独立标题由同目录的 layout.tsx 提供（appPageMetadata）。
export const metadata: Metadata = {
  title: SITE_NAME_FULL,
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
}

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return <SidebarLayout>{children}</SidebarLayout>
}
