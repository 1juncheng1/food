import type { Metadata } from 'next'
import { pageMetadata } from '@/lib/seo'

// 注册页：同登录页，工具页 noindex（需要时可把 index 改为 true）
export const metadata: Metadata = pageMetadata({
  title: '注册 · 银河叙事',
  description: '注册银河叙事账号，开始你的第一次 AI 创作。',
  path: '/register',
  index: false,
})

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
