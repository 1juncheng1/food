import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '积分充值',
  description: '为账号充值积分，继续创作。',
  path: '/recharge',
})

export default function RechargeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
