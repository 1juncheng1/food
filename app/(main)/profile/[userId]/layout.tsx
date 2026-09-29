import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

type Props = { params: Promise<{ userId: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { userId } = await params
  return appPageMetadata({
    title: '创作者主页',
    description: '这位创作者的公开作品与创作档案。',
    path: `/profile/${userId}`,
  })
}

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
