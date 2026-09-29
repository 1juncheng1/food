import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '设置',
  description: '管理账号信息、通知与使用偏好。',
  path: '/settings',
})

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
