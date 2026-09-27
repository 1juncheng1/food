'use client'

// ============================================================
// /works/[id]：历史链接兼容层
// 第三阶段起全站作品详情统一为「持续创作空间」/article/[id]
// （版本历史 / AI 诊断 / 定向迭代 / 定稿都在该页）。
// 本页只做 replace 重定向，保证旧收藏、历史消息里的 /works/ 链接不失效，
// 且不新增历史条目（浏览器返回键不会卡在这个空页）。
// ============================================================

import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'

export default function WorkDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()

  useEffect(() => {
    router.replace(`/article/${params.id}`)
  }, [params.id, router])

  return (
    <div className="inner-page " data-mode="inspiration">
      <div className="vs-spinner w-5 h-5" />
    </div>
  )
}
