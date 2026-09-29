import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

// /works/[id] 是历史链接兼容层，服务端 301 已把旧地址直接送到 /article/[id]，
// 这里仅保留标题兜底（正常流量不会停留在本页）。
export const metadata: Metadata = appPageMetadata({
  title: '作品详情',
  description: '查看这篇作品的创作空间。',
  path: '/works/[id]',
})

export default function WorkDetailLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
