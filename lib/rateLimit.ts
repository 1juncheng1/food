// 极简内存限流器：固定窗口计数，按 key（用户 ID / IP）限制请求频率。
// 注意：Serverless 环境下每个实例独立计数，属于基础防护而非硬性配额；
// 如需精确限流，可替换为 Upstash Redis 等方案。

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

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfterSec: number } {
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
