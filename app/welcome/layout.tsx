import type { Metadata } from 'next'
import { pageMetadata } from '@/lib/seo'

// 注册后访谈页：仅对新注册用户出现，必须 noindex
export const metadata: Metadata = pageMetadata({
  title: '欢迎来到视界',
  description: '回答几个问题，让 AI 从第一篇起就懂你的表达。',
  path: '/welcome',
  index: false,
})

export default function WelcomeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
