// ============================================================
// POST /api/seo/indexnow —— 触发 IndexNow 推送（Bing / Edge 即时收录）
//
// 两个用法：
//   1. 不带 body：推送站点当前全部公开 URL（取自 lib/seo.ts 的 PUBLIC_PATHS）
//   2. 带 body { "urls": ["/post/xxx"] }：只推指定 URL
//      —— 用于将来社区页开放公开阅读后，发布即推送
//
// 鉴权：requireAdmin
//   这不是公开接口：IndexNow 的 key 被判为垃圾提交会连累整个域名，
//   任何登录用户都能触发 = 任何人都能拿域名信誉开玩笑。
// 限流：全局 5 次 / 分钟（跨用户共享，按用户限流没有意义）
//
// 幂等且安全：重复推送同一 URL 不会受罚，IndexNow 本身就去重。
// 失败不影响业务：SEO 是旁路功能，这里只如实返回结果，不抛异常。
// ============================================================

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/adminAuth'
import { rateLimit, tooManyRequestsResponse } from '@/lib/rateLimit'
import { submitPublicUrlsToIndexNow, submitToIndexNow } from '@/lib/indexnow'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const NO_STORE = { 'Cache-Control': 'no-store' } as const
/** 单次最多接受的自定义 URL 数量 */
const MAX_CUSTOM_URLS = 100

export async function POST(req: Request) {
  const admin = await requireAdmin(req)
  if (!admin.ok) return admin.response

  const rl = rateLimit('seo-indexnow', 5, 60_000)
  if (!rl.ok) return tooManyRequestsResponse(rl.retryAfterSec, '推送过于频繁，请稍后再试')

  // body 可选：解析失败按「推送全部公开 URL」处理，不报错
  let urls: unknown
  try {
    const body: unknown = await req.json()
    urls = (body as { urls?: unknown } | null)?.urls
  } catch {
    urls = undefined
  }

  // 指定了 URL：只推这些（必须是站内相对路径或绝对地址，submitToIndexNow 会过滤）
  if (Array.isArray(urls)) {
    const list = urls.filter((u): u is string => typeof u === 'string').slice(0, MAX_CUSTOM_URLS)
    if (list.length === 0) {
      return NextResponse.json(
        { error: 'urls 为空或格式不正确' },
        { status: 400, headers: NO_STORE }
      )
    }
    const result = await submitToIndexNow(list)
    return NextResponse.json(result, { status: result.ok ? 200 : 502, headers: NO_STORE })
  }

  const result = await submitPublicUrlsToIndexNow()
  return NextResponse.json(result, { status: result.ok ? 200 : 502, headers: NO_STORE })
}
