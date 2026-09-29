import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '创作结果',
  description: '查看这一轮创作结果，继续修改或定为最终作品。',
  path: '/generate/result',
})

export default function GenerateResultLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
