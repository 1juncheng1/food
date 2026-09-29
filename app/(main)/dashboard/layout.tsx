import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

// 工作台：本层所有页面统一 noindex（见 (main)/layout.tsx），
// 这里的 metadata 只负责标题、canonical 与分享预览。
export const metadata: Metadata = appPageMetadata({
  title: '工作台',
  description: '你的创作工作台：每日灵感推荐、进行中的作品与创作数据都在这里。',
  path: '/dashboard',
})

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
