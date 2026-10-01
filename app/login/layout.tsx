import type { Metadata } from 'next'
import { pageMetadata } from '@/lib/seo'

// 登录页：公开可达但属于工具页，没有可被搜索的价值内容 → noindex，
// 避免稀释整站质量。若希望「品牌名 登录」参与搜索，把 index 改为 true 即可。
export const metadata: Metadata = pageMetadata({
  title: '登录 · 银河叙事',
  description: '登录你的银河叙事账号，继续创作。',
  path: '/login',
  index: false,
})

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
