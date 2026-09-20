// ============================================================
// Creator Interest Profile —— 事件输入清洗（纯函数）
//
// 与项目既有哲学一致：所有外部输入进库前 normalize，
// 超长截断、非法值兜底，保证脏数据永不进事实账本。
// ============================================================

import { PAYLOAD_TEXT_MAX, TOPIC_EXCERPT_MAX } from './config'

/** 安全截断字符串并 trim；非字符串返回空串 */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  return s.length > max ? s.slice(0, max) : s
}

/** 主题摘录专用（≤100 字） */
export function cleanTopicExcerpt(v: unknown): string {
  return cleanText(v, TOPIC_EXCERPT_MAX)
}

/** 清洗 ID 类字段（列约束 target_id 无长度限制，但幂等键需要可控长度） */
export function cleanId(v: unknown, max = 100): string {
  return cleanText(v, max)
}

/**
 * 清洗 payload：
 *   - 剔除 undefined / function / symbol（JSON 不可序列化值）
 *   - 字符串字段统一截断（嵌套对象最多处理两层，事件 payload 结构都很扁）
 *   - topic_excerpt 走专用 100 字红线
 */
export function sanitizePayload(
  input: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null) continue
    const t = typeof raw
    if (t === 'function' || t === 'symbol') continue

    if (t === 'string') {
      out[key] = cleanText(raw, key === 'topic_excerpt' ? TOPIC_EXCERPT_MAX : PAYLOAD_TEXT_MAX)
      continue
    }
    if (t === 'number' || t === 'boolean') {
      out[key] = raw
      continue
    }
    if (Array.isArray(raw)) {
      // 数组只保留原始值，元素截断处理
      out[key] = raw
        .filter((x) => x !== undefined && x !== null && typeof x !== 'object')
        .map((x) => (typeof x === 'string' ? cleanText(x, PAYLOAD_TEXT_MAX) : x))
        .slice(0, 20)
      continue
    }
    // 浅对象：只保留一层原始值字段
    if (t === 'object') {
      const sub: Record<string, unknown> = {}
      for (const [sk, sv] of Object.entries(raw as Record<string, unknown>)) {
        if (sv === undefined || sv === null || typeof sv === 'object') continue
        sub[sk] = typeof sv === 'string' ? cleanText(sv, PAYLOAD_TEXT_MAX) : sv
      }
      out[key] = sub
    }
  }
  return out
}

/** 校验向量：必须是 1024 个有限数；不合规返回 null（向量列允许为空，不阻断事件） */
export function cleanEmbedding(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== 1024) return null
  for (let i = 0; i < 1024; i++) {
    const n = v[i]
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
  }
  return v as number[]
}

/** ISO 时间或 Date → ISO 字符串；非法值返回 null（让库默认 now() 生效） */
export function cleanOccurredAt(v: unknown): string | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? new Date(t).toISOString() : null
  }
  return null
}
