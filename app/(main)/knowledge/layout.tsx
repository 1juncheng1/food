import type { Metadata } from 'next'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: '知识库',
  description: '沉淀你自己的创作知识：观点、事实与表达方式，让 AI 创作有据可依。',
  path: '/knowledge',
})

export default function KnowledgeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
