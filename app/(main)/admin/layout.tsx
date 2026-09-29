import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

// 后台：涵盖 /admin/points 与 /admin/recharge，只在 robots.txt 之外再加一层 noindex
export const metadata: Metadata = appPageMetadata({
  title: '后台管理',
  description: '站点管理后台（仅管理员可访问）。',
  path: '/admin',
})

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
