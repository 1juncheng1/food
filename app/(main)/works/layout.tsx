import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '作品成长档案',
  description: '每篇作品的成长记录：经历了几个版本、被改了几次、AI 诊断过什么。',
  path: '/works',
})

export default function WorksLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
