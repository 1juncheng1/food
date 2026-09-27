// ============================================================
// Creator Interest Profile —— 口味模型（✕ 原因 → 簇 → 惩罚乘子）
//
// 为什么单独成文件：builder / refill / rescore 三处都要吃同一份口径。
// 它原先住在 builder.ts，于是任何想用它的模块都必须把整个 builder（含
// DeepSeek 调用、supabase 依赖）拖进依赖图。rescore 是读路径模块，
// 让它 import builder 会形成 builder ↔ rescore 循环依赖。抽出来是唯一干净解。
// ============================================================

import {
  TASTE_PENALTY,
  TASTE_PENALTY_NO_REASON,
  TASTE_PENALTY_WINDOW_DAYS,
  DISMISS_REASON_CODES,
  type DismissReasonCode,
} from './config'
import type { TasteEntry } from './ranking'

/**
 * 从 ✕ 事件反推"哪些方向被明确拒绝、因为什么"。
 *
 * 键值用 payload.cluster_code 而不是 cluster_id：cluster_id 每次 build 都会重生成，
 * 而 code 是跨 build 稳定的方向标识——用 id 会导致上一个 build 攒下的口味
 * 在下一个 build 全部失效，Taste Model 永远学不会东西。
 *
 * 同簇多次 ✕ 取最强（最小）乘子，不叠加：叠加会让"越点越死"，
 * 把本该保留的探索空间彻底封死。
 */
export function buildTasteMap(
  rows: Array<{ occurredAt: string; payload: Record<string, unknown> | null }>,
  now: Date
): Map<string, TasteEntry> {
  const out = new Map<string, TasteEntry>()
  const windowStart = now.getTime() - TASTE_PENALTY_WINDOW_DAYS * 86_400_000
  for (const r of rows) {
    const at = Date.parse(r.occurredAt)
    if (!Number.isFinite(at) || at < windowStart) continue
    const code = r.payload?.cluster_code
    if (typeof code !== 'string' || !code || code === 'no_cluster') continue
    const raw = r.payload?.reason_code
    const reason: DismissReasonCode | null =
      typeof raw === 'string' && (DISMISS_REASON_CODES as readonly string[]).includes(raw)
        ? (raw as DismissReasonCode)
        : null
    const penalty = reason ? TASTE_PENALTY[reason] : TASTE_PENALTY_NO_REASON
    const prev = out.get(code)
    if (!prev || penalty < prev.penalty) out.set(code, { penalty, reason })
  }
  return out
}
