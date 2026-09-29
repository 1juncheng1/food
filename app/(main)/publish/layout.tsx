import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '发布到灵感广场',
  description: '把完成的灵感或作品发布到灵感广场，与其他创作者交流。',
  path: '/publish',
})

export default function PublishLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
