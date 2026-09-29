import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '新建创作',
  description: '开始一次新的创作。',
  path: '/add',
})

export default function AddLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
