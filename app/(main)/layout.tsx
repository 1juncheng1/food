import { SidebarLayout } from '@/components/sidebar-layout'

// ────────────────────────────────────────────────────────────
// (main) 路由组布局：左侧固定导航栏 + 右侧内容区
// 路由组 (main) 不影响 URL，/dashboard 依然是 /dashboard
// SidebarLayout 为客户端组件，管理侧边栏折叠/展开状态并联动内容区 margin
// AuthGuard 在此层统一鉴权，未登录跳转 /login
// ────────────────────────────────────────────────────────────

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return <SidebarLayout>{children}</SidebarLayout>
}
