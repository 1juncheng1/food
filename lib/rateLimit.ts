// ============================================================
// 限流器：内存版（同步）+ Redis 版（异步，跨实例）
//
// 为什么有两个版本：
//   · rateLimit()      同步、零依赖、零网络开销。单实例部署够用，
//                      也是所有存量调用点的默认行为（签名不变，向后兼容）。
//   · rateLimitAsync() 异步，优先走 Upstash Redis（HTTP REST，无需装依赖），
//                      Redis 不可用时**自动降级**到内存版。
//
// 为什么必须有 Redis 版（这是"100 人同时用"的硬门槛）：
//   Serverless 每个实例有自己独立的内存。只靠内存计数时，平台扩容到
//   N 个实例，同一用户的实际可用额度就是限流值的 N 倍——限流形同虚设。
//   AI 接口尤甚：它们背后是真实的 token 计费，额度被放大 N 倍 = 账单被放大 N 倍。
//
// 降级原则：Redis 出故障时必须**放行而不是拒绝**。限流器是保护成本的手段，
//   不是鉴权手段；宁可短暂失去限流，也不能让 Redis 抖动变成整站 429。
//
// 配置（都可选，不配就走内存）：
//   UPSTASH_REDIS_REST_URL   https://xxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN Bearer token
// 两者必须成对配置，缺一个就当作未启用。
// ============================================================

import { NextResponse } from 'next/server'

const buckets = new Map<string, { count: number; resetAt: number }>()

/**
 * key 数量硬上限：防止攻击者用海量不同 userId/IP 灌满 Map。
 * 达到上限时新 key 直接拒绝（返回不 ok），优先保证进程不被 OOM。
 */
const MAX_KEYS = 10_000

/** 超过 1000 个 key 时清理已过期的桶，避免内存无限增长 */
function cleanupExpired(now: number) {
  if (buckets.size < 1000) return
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

/**
 * 从请求中提取客户端 IP（用于游客/未登录场景的限流 key）。
 * 仅取 x-forwarded-for 的第一段（最左侧为真实客户端，右侧可被追加伪造）。
 */
export function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  const real = req.headers.get('x-real-ip')?.trim()
  if (real) return real
  return 'unknown'
}

/** 限流判定结果 */
export type RateLimitResult = { ok: boolean; retryAfterSec: number }

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now()
  cleanupExpired(now)

  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    // 桶已满且是全新 key：拒绝，避免 Map 无限膨胀
    if (buckets.size >= MAX_KEYS) {
      return { ok: false, retryAfterSec: Math.ceil(windowMs / 1000) }
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, retryAfterSec: 0 }
  }
  if (bucket.count >= limit) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) }
  }
  bucket.count += 1
  return { ok: true, retryAfterSec: 0 }
}

// ────────────────────────────────────────────────────────────
// Redis（Upstash REST）后端
// ────────────────────────────────────────────────────────────

/** Redis 单次请求超时：限流不能拖慢业务，超时即降级 */
const REDIS_TIMEOUT_MS = 1_500

type RedisConfig = { url: string; token: string } | null

/**
 * 读取 Redis 配置。两个变量必须成对出现，缺一个视为未启用——
 * 半配置状态下逐个请求都去打一次注定失败的 HTTP，只会平白增加延迟。
 */
function redisConfig(): RedisConfig {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim()
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  if (!url || !token) return null
  return { url: url.replace(/\/+$/, ''), token }
}

/**
 * 固定窗口计数，用 Redis 原子 INCR 实现。
 *
 * 关键细节：过期时间只在**第一次**计数时设置（PEXPIRE ... NX）。
 * 若每次都无条件续期，窗口会变成"只要持续访问就永不重置"的滑动窗口，
 * 用户连续操作 5 分钟就会被误判成超过 1 分钟限额。
 *
 * 用 pipeline 把 INCR 与 PEXPIRE 合并成一次 HTTP 往返，
 * 避免"计数成功但没设过期"留下永久封禁的脏 key。
 */
async function redisIncr(
  cfg: NonNullable<RedisConfig>,
  key: string,
  windowMs: number
): Promise<number | null> {
  const res = await fetch(`${cfg.url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      ['INCR', key],
      // Redis 7 才有 NX 选项；老实例会返回 error，但 INCR 的结果仍可取用
      ['PEXPIRE', key, String(windowMs), 'NX'],
    ]),
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
  })

  if (!res.ok) return null

  const data: unknown = await res.json()
  // Upstash 返回 [{result: n}, {result: 1|0}]
  // 第二个命令报错时形如 [{result: n}, {error: '...'}]
  const first = Array.isArray(data) ? (data[0] as { result?: unknown } | undefined) : undefined
  const n = first?.result
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/**
 * 跨实例限流（AI 等按次计费的接口**必须**用这个）。
 *
 * Redis 可用时以 Redis 计数为准（所有实例共享同一份计数）；
 * Redis 未配置或调用失败时降级为内存版并返回结果，绝不因此拒绝请求。
 */
export async function rateLimitAsync(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const cfg = redisConfig()
  if (cfg) {
    try {
      const count = await redisIncr(cfg, `rl:${key}`, windowMs)
      if (count !== null) {
        if (count > limit) {
          return { ok: false, retryAfterSec: Math.ceil(windowMs / 1000) }
        }
        return { ok: true, retryAfterSec: 0 }
      }
    } catch {
      // 网络/超时/解析异常一律降级，不中断业务
    }
  }
  return rateLimit(key, limit, windowMs)
}

/**
 * 生成标准的 429 响应。
 *
 * Retry-After 必带：前端可以据此显示"请 30 秒后再试"，
 * 否则用户只会看到一句干巴巴的"操作过于频繁"然后疯狂重试。
 */
export function tooManyRequestsResponse(
  retryAfterSec: number,
  message = '操作过于频繁，请稍后再试'
): NextResponse {
  return NextResponse.json(
    { error: message, retryAfterSec },
    {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))),
      },
    }
  )
}

/**
 * 「鉴权 + 限流」一步到位的守卫，供写操作/AI 路由使用。
 * 为什么把两者绑在一起：限流 key 是 userId，必须先拿到身份。
 * 分开写容易出现"忘记鉴权直接限流"，那样攻击者换 IP 就能绕。
 *
 * @param req     原始请求
 * @param userId  已鉴权的用户 ID（由调用方从 authenticateRequest 取得）
 * @param scope   业务标识，如 'work-agent-chat'
 * @param limit   窗口内允许的次数
 * @param windowMs 窗口长度
 * @returns null 表示通过；否则是可直接 return 的 429 响应
 */
export async function guardRateLimit(
  userId: string,
  scope: string,
  limit: number,
  windowMs: number,
  message?: string
): Promise<NextResponse | null> {
  const rl = await rateLimitAsync(`${scope}:${userId}`, limit, windowMs)
  if (rl.ok) return null
  return tooManyRequestsResponse(rl.retryAfterSec, message)
}

// ────────────────────────────────────────────────────────────
// 并发闸门（在飞请求数上限）
//
// 为什么频率限流之外还需要它：
//   频率限流回答的是"你一分钟能发多少次"，并发闸门回答的是
//   "同一时刻能有多少个在跑"。AI 请求单次耗时 20~120 秒，
//   100 人各发 1 次也才 100 次/分钟（频率限流可能放行），
//   但这 100 个请求会**同时**挂在函数进程里，直接把 Serverless 并发槽位
//   和上游 DeepSeek 的并发额度一起打满——剩下的请求全部排队超时。
//
// 为什么用"滑动窗口内启动的请求数"而不是"获取/释放信号量"：
//   Serverless 的进程随时可能被平台杀掉，释放逻辑根本跑不到，
//   信号量会永久泄漏、最终把所有请求都挡在门外。
//   改成"记录请求开始时间戳、只统计最近 windowMs 内启动的数量"，
//   每个条目靠 TTL 自动消失，不需要任何释放动作——对不可靠进程免疫。
//   语义上等价于并发上限（窗口取单次请求最大耗时即可）。
// ────────────────────────────────────────────────────────────

/** 内存版在飞窗口：key → 请求开始时间戳数组 */
const inFlight = new Map<string, number[]>()

/** 在飞窗口最大 key 数，防内存膨胀 */
const MAX_INFLIGHT_KEYS = 5_000

function inFlightCount(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  const cutoff = now - windowMs

  if (inFlight.size > MAX_INFLIGHT_KEYS) {
    for (const [k, list] of inFlight) {
      if (list.every((t) => t <= cutoff)) inFlight.delete(k)
    }
  }

  const list = (inFlight.get(key) ?? []).filter((t) => t > cutoff)
  if (list.length >= limit) {
    inFlight.set(key, list)
    // 取最早那条的过期时间作为可重试时刻
    const retryAfterSec = Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000))
    return { ok: false, retryAfterSec }
  }
  list.push(now)
  inFlight.set(key, list)
  return { ok: true, retryAfterSec: 0 }
}

/**
 * 并发闸门：窗口内启动的请求数超过 limit 就拒绝。
 *
 * Redis 版用 ZSET 实现：分数为开始时间戳，每次先清理过期成员再计数，
 * 全部命令一次 pipeline 往返完成，无需显式释放。
 */
export async function concurrencyGuard(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const cfg = redisConfig()
  if (cfg) {
    try {
      const now = Date.now()
      const member = `${now}-${Math.random().toString(36).slice(2, 10)}`
      const res = await fetch(`${cfg.url}/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          // 清掉窗口外的旧条目
          ['ZREMRANGEBYSCORE', key, '0', String(now - windowMs)],
          // 记录本次开始
          ['ZADD', key, String(now), member],
          // 当前在飞数
          ['ZCARD', key],
          // 整键兜底过期，避免冷 key 常驻
          ['PEXPIRE', key, String(windowMs * 2)],
        ]),
        signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
      })
      if (res.ok) {
        const data: unknown = await res.json()
        const third = Array.isArray(data) ? (data[2] as { result?: unknown } | undefined) : undefined
        const count = third?.result
        if (typeof count === 'number' && Number.isFinite(count)) {
          if (count > limit) {
            return { ok: false, retryAfterSec: Math.max(1, Math.ceil(windowMs / 1000)) }
          }
          return { ok: true, retryAfterSec: 0 }
        }
      }
    } catch {
      // 降级到内存版
    }
  }
  return inFlightCount(key, limit, windowMs)
}

/**
 * 系统繁忙响应。
 *
 * 用 503 而不是 429：429 是"你发太快"（用户的锅，等一会重试即可），
 * 503 是"我现在接不住"（系统的锅，前端该做退避重试而不是原地狂点）。
 * 语义分清，前端才能给出正确的交互。
 */
export function serviceBusyResponse(retryAfterSec: number): NextResponse {
  return NextResponse.json(
    { error: '系统繁忙，请稍后重试', retryAfterSec, retryable: true },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))),
      },
    }
  )
}
