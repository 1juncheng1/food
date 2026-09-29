import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '灵感分析中',
  description: '正在分析你的灵感，理解你真正想表达的内容。',
  path: '/generate/analyzing',
})

export default function AnalyzingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
