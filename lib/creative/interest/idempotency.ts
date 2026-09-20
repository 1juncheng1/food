// ============================================================
// Creator Interest Profile —— 幂等键规则（纯函数）
//
// 规范（setup.sql 16.4 的 unique(user_id, idempotency_key)）：
//   live:{targetType}:{targetId}:{eventType}[:{yyyy-MM-dd}]
//   backfill:{...} 前缀供 M3 存量回填使用，与实时流互不冲突。
//
// 同一业务动作（网络重试、前端重复提交）只入账一次；
// 同一 target 的反复动作（定稿/撤回/编辑/重做）按天加后缀，
// 使"定稿→撤回→再次定稿"这类真实反复操作各自入账。
// ============================================================

import type { CreatorEventType, TargetType } from './types'

export type IdempotencySource = 'live' | 'backfill'

export interface IdempotencyInput {
  source?: IdempotencySource
  targetType: TargetType
  /** 目标 ID；纯主题类行为传 null，用主题文本指纹兜底 */
  targetId?: string | null
  eventType: CreatorEventType
  /** 反复动作按天入账时传 true */
  daily?: boolean
  /** targetId 缺失时的兜底指纹（如 query_hash） */
  fallbackFingerprint?: string | null
  occurredAt?: string | Date | null
}

function dayPart(v: string | Date | null | undefined): string {
  if (!v) return new Date().toISOString().slice(0, 10)
  const d = v instanceof Date ? v : new Date(v)
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
}

export function buildIdempotencyKey(input: IdempotencyInput): string {
  const source = input.source ?? 'live'
  const target =
    input.targetId?.trim() ||
    input.fallbackFingerprint?.trim() ||
    'none'
  const parts = [source, input.targetType, target, input.eventType]
  if (input.daily) parts.push(dayPart(input.occurredAt))
  return parts.join(':')
}
