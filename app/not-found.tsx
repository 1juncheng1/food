import Link from 'next/link'

// ────────────────────────────────────────────────────────────
// 全局 404：任何未匹配的 URL 都渲染本页，并返回真实的 404 状态码。
// Next.js 会对 404 响应自动注入 <meta name="robots" content="noindex">，
// 因此这里不需要（也不应该）再手工设置 robots。
// ────────────────────────────────────────────────────────────

export default function NotFound() {
  return (
    <div
      className="inner-page flex min-h-[70vh] flex-col items-center justify-center px-5 py-16 text-center"
      data-mode="inspiration"
    >
      <p className="vs-mark">404</p>
      <h1 className="vs-h1 mt-4">页面不存在或已被移除</h1>
      <p className="vs-note mt-3 max-w-md leading-relaxed">
        链接可能已过期，或该内容仅对其创作者可见。
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link href="/" className="vs-btn vs-btn-primary">
          回到首页
        </Link>
        <Link href="/login" className="vs-btn vs-btn-ghost">
          去登录
        </Link>
      </div>
    </div>
  )
}
