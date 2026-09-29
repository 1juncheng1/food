import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '我的积分',
  description: '查看积分余额与获取、消耗记录。',
  path: '/points',
})

export default function PointsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
