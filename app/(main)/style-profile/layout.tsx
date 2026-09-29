import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '风格画像',
  description: '你的创作风格画像：AI 据此让生成的内容更像你写的。',
  path: '/style-profile',
})

export default function StyleProfileLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
