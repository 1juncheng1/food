import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: 'AI 创作',
  description: '把一个模糊的想法变成可以发布的作品：AI 理解你的意图，陪你完成生成与修改。',
  path: '/generate',
})

export default function GenerateLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
