import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

type Props = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  return appPageMetadata({
    title: '创作方案详情',
    description: '查看这份创作方案的完整内容。',
    path: `/solution/${id}`,
  })
}

export default function SolutionDetailLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
