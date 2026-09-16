// 极简内存限流器：固定窗口计数，按 key（用户 ID）限制请求频率。
// 注意：Serverless 环境下每个实例独立计数，属于基础防护而非硬性配额；
// 如需精确限流，可替换为 Upstash Redis 等方案。

const buckets = new Map<string, { count: number; resetAt: number }>()

/** 超过 1000 个 key 时清理已过期的桶，避免内存无限增长 */
function cleanupExpired(now: number) {
  if (buckets.size < 1000) return
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
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
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, retryAfterSec: 0 }
  }
  if (bucket.count >= limit) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) }
  }
  bucket.count += 1
  return { ok: true, retryAfterSec: 0 }
}
