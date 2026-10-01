import type { Metadata } from 'next'
import { CreationFlowProvider } from '@/components/generate/creation-flow-provider'
import { appPageMetadata } from '@/lib/seo'

export const metadata: Metadata = appPageMetadata({
  title: 'AI 创作',
  description: '把一个模糊的想法变成可以发布的作品：AI 理解你的意图，陪你完成生成与修改。',
  path: '/generate',
})

// CreationFlowProvider 必须包住整个 generate 路由树（/generate、/analyzing、/result），
// 这些页面都通过 useCreationFlow 读取创作流状态——上一轮加 metadata 时误删了它，
// 导致 /generate 客户端崩溃（useCreationFlow must be used inside CreationFlowProvider）。
export default function GenerateLayout({ children }: { children: React.ReactNode }) {
  return <CreationFlowProvider>{children}</CreationFlowProvider>
}
