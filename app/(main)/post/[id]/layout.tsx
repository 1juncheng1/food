import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

type Props = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  return appPageMetadata({
    title: '帖子详情',
    description: '查看这篇帖子、创作档案与讨论。',
    path: `/post/${id}`,
  })
}

export default function PostDetailLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
