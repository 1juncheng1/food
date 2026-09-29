import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '素材库',
  description: '管理你的个人素材库，创作时随时取用。',
  path: '/materials',
})

export default function MaterialsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
