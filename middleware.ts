import { NextResponse, type NextRequest } from 'next/server'
import {
  concurrencyGuard,
  getClientIp,
  rateLimitAsync,
  serviceBusyResponse,
  tooManyRequestsResponse,
} from '@/lib/rateLimit'

/**
 * 全局安全响应头基线 + API 全局限流。
 *
 * 说明：本项目目前把 session 存在浏览器 localStorage、通过 Authorization: Bearer
 * 传给 Route Handler（见 lib/supabaseServer.ts），没有走 cookie 会话，
 * 因此 middleware 无法做「未登录跳登录页」这类路由保护——
 * 每个 Route Handler 必须自己鉴权（现状已如此，请勿依赖本文件做鉴权）。
 *
 * 这里做两件事，都属于纵深防御：
 *   1. 下发安全响应头
 *   2. 对 /api/* 做**按 IP 的全局限流**——业务路由里那 30 处按 userId 的限流
 *      只覆盖到已改造的入口，这里是最后一道网，任何新增/遗漏的接口都逃不掉。
 *
 * 为什么限流放在 middleware 而不是每个路由里写：
 *   逐个路由补限流是"人肉覆盖率"问题——加一个忘一个，永远补不全。
 *   集中在 middleware 一次覆盖全部 /api/*，新接口自动受保护。
 *   路由内按 userId 的限流仍然保留（更精准：能区分同一 IP 后的多个用户）。
 *
 * 暂不启用 CSP：本项目存在 Next.js 注入的内联脚本与内联样式，
 * 上严格 CSP 需要配合 nonce，改动面较大，建议单独立项。
 */

/**
 * 昂贵接口前缀：背后是真实计费的 LLM / 图像生成 / 嵌入调用，或全量数据导出。
 * 这些入口额度必须显著低于普通 CRUD——它们花的不是服务器 CPU，是钱。
 */
const EXPENSIVE_PREFIXES = [
  '/api/creative/',
  '/api/prompt-optimizer',
  '/api/problem-solve',
  '/api/upload-image',
  '/api/export-data',
  '/api/materials/retrieve',
  '/api/ci/',
]

/** 昂贵接口：每 IP 每分钟上限 */
const EXPENSIVE_LIMIT_PER_MIN = 60
/** 普通接口：每 IP 每分钟上限（前端单页并发多个请求，额度必须宽松） */
const DEFAULT_LIMIT_PER_MIN = 180

const ONE_MINUTE_MS = 60_000

/**
 * 在飞的昂贵请求数上限（全局，不按 IP 区分）。
 *
 * 频率限流管不了这个：AI 请求单次耗时 20~120 秒，100 人各发 1 次
 * 频率上完全合规，但这 100 个请求会同时占住函数槽位和上游并发额度，
 * 后面的请求全部排队直到超时。
 *
 * 窗口取 30s —— 略大于单次 AI 请求的最大耗时（AI_TIMEOUT_BUDGET_MS 默认 25s），
 * 于是"窗口内启动的数量"≈"同时在飞的数量"。
 *
 * 超出返回 503 让前端退避重试，而不是让请求排队等死：
 * 排队只会让每个请求都耗到超时，用户体验和成本都更差。
 */
function maxAiConcurrency(): number {
  const raw = Number(process.env.AI_MAX_CONCURRENCY)
  return Number.isFinite(raw) && raw >= 1 && raw <= 10_000 ? Math.floor(raw) : 25
}

const AI_INFLIGHT_WINDOW_MS = 30_000

function classify(pathname: string): { bucket: string; limit: number } {
  const expensive = EXPENSIVE_PREFIXES.some((p) => pathname.startsWith(p))
  return {
    bucket: expensive ? 'expensive' : 'default',
    limit: expensive ? EXPENSIVE_LIMIT_PER_MIN : DEFAULT_LIMIT_PER_MIN,
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // ── 1. API 全局限流（按 IP）──────────────────────────────
  if (pathname.startsWith('/api/')) {
    const { bucket, limit } = classify(pathname)
    const ip = getClientIp(req)
    const rl = await rateLimitAsync(`mw:${bucket}:${ip}`, limit, ONE_MINUTE_MS)
    if (!rl.ok) {
      return tooManyRequestsResponse(
        rl.retryAfterSec,
        bucket === 'expensive'
          ? 'AI 服务调用过于频繁，请稍后再试'
          : '请求过于频繁，请稍后再试'
      )
    }

    // 昂贵接口还要过并发闸门：频率合规 ≠ 不会挤爆
    if (bucket === 'expensive') {
      const cg = await concurrencyGuard('mw:ai-inflight', maxAiConcurrency(), AI_INFLIGHT_WINDOW_MS)
      if (!cg.ok) return serviceBusyResponse(cg.retryAfterSec)
    }
  }

  // ── 2. 安全响应头 ────────────────────────────────────────
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
