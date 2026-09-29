// ============================================================
// /api/seo/indexnow —— 触发 IndexNow 推送（Bing / Edge 即时收录）
//
// 调用方式二选一：
//   1. 管理员 Bearer token（requireAdmin）
//   2. Vercel Cron：请求头带 Authorization: Bearer $CRON_SECRET
//      —— 定时任务没有用户身份，只能靠这个共享密钥
//
// GET 与 POST 都支持：Vercel Cron 用 GET 调用，手动触发用 POST。
//
// 两种用法：
//   · 不带参数：推送站点当前全部公开 URL（取自 lib/seo.ts 的 PUBLIC_PATHS）
//   · body { "urls": ["/post/xxx"] }：只推指定 URL
//     —— 用于将来社区页开放公开阅读后，发布即推送
//
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

/**
 * 判断是否是 Vercel Cron 的调用。
 *
 * 未配置 CRON_SECRET 时一律返回 false —— 宁可让定时任务 401，
 * 也不能在没配密钥的情况下把接口敞开。
 */
function isCronCaller(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return false
  return (req.headers.get('authorization') ?? '') === `Bearer ${secret}`
}

async function handle(req: Request): Promise<NextResponse> {
  if (!isCronCaller(req)) {
    const admin = await requireAdmin(req)
    if (!admin.ok) return admin.response
  }

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

export async function GET(req: Request) {
  return handle(req)
}

export async function POST(req: Request) {
  return handle(req)
}
