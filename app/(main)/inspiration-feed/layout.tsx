import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '灵感流',
  description: '为你挑选的灵感内容流，按你的创作兴趣持续更新。',
  path: '/inspiration-feed',
})

export default function InspirationFeedLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
