import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '我的主页',
  description: '你的创作者主页：发布的作品与创作档案。',
  path: '/profile/me',
})

export default function ProfileMeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
