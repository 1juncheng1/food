import type { Metadata } from 'next'
import { JsonLd } from '@/components/seo/json-ld'
import { appPageMetadata, breadcrumbJsonLd } from '@/lib/seo'

type Props = { params: Promise<{ id: string }> }

// 动态路由的 canonical 需要带上真实 id，因此用 generateMetadata 而不是静态对象。
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  return appPageMetadata({
    title: '创作空间',
    description: '在这篇作品的创作空间里继续打磨：版本历史、AI 诊断与定向迭代。',
    path: `/article/${id}`,
  })
}

export default async function ArticleLayout({
  children,
  params,
}: Props & { children: React.ReactNode }) {
  const { id } = await params

  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: '首页', path: '/' },
          { name: '工作台', path: '/dashboard' },
          { name: '创作空间', path: `/article/${id}` },
        ])}
      />
      {children}
    </>
  )
}
