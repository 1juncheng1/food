import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '灵感广场',
  description: '看看其他创作者正在发布什么：灵感、作品与完整的创作档案。',
  path: '/explore',
})

export default function ExploreLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
