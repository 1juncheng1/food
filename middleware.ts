import { NextResponse, type NextRequest } from 'next/server'

/**
 * 全局安全响应头基线。
 *
 * 说明：本项目目前把 session 存在浏览器 localStorage、通过 Authorization: Bearer
 * 传给 Route Handler（见 lib/supabaseServer.ts），没有走 cookie 会话，
 * 因此 middleware 无法做「未登录跳登录页」这类路由保护——
 * 每个 Route Handler 必须自己鉴权（现状已如此，请勿依赖本文件做鉴权）。
 *
 * 这里只下发与安全相关的响应头，属于纵深防御：
 *   - X-Content-Type-Options：阻止浏览器 MIME 嗅探，避免把响应当脚本执行
 *   - X-Frame-Options：阻止被嵌套进 iframe（点击劫持）
 *   - Referrer-Policy：避免完整 URL 通过 referer 外泄
 *   - Permissions-Policy：关闭本项目用不到的浏览器能力
 *   - Strict-Transport-Security：仅生产环境（HTTPS）下发，强制后续走 HTTPS
 *
 * 暂不启用 CSP：本项目存在 Next.js 注入的内联脚本与内联样式，
 * 上严格 CSP 需要配合 nonce，改动面较大，建议单独立项。
 */
export function middleware(_req: NextRequest) {
  const res = NextResponse.next()

  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('X-Frame-Options', 'DENY')
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()'
  )
  if (process.env.NODE_ENV === 'production') {
    res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
  }

  return res
}

export const config = {
  // 排除静态资源与图片优化，避免给每个资源请求都套一层中间件
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
