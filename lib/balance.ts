// ============================================================
// lib/balance —— 兼容层（Phase 1 之后的新口径在 lib/points.ts）
//
// 这个文件曾经是余额的唯一出处。Phase 1 建立了「余额 + 流水」之后，
// 记账读写全部迁到 lib/points.ts（含 point_config 配置化汇率）。
//
// 这里**只保留两件事**：
//   1. AI token 计价（usageCostYuan / chargePointsForUsage）——纯函数，
//      被 prompt-optimizer 与测试直接依赖，且它没有必须搬家的理由；
//   2. 旧签名的兼容转发（fetchBalance / ensureBalance / consumeBalance），
//      让既有调用点不用一次性改完就能拿到流水与幂等能力。
//
// ⚠ 新代码请直接用 lib/points.ts，别再往这里加东西。
//
// 一条贯穿全局的红线：**读不到余额 ≠ 余额为 0**。
//   数据库抖动、策略没刷、网络超时，都会让查询失败。若把它当 0 处理，
//   用户会看到「当前没有余额，请充值」——和之前"网络故障被当成登录过期"
//   是同一类错误：把可用性问题伪装成业务判定。所以：
//     · 读取失败 → 返回 null → 调用方**放行**（fail-open，宁可少收钱也别冤枉用户）
//     · 查到余额（哪怕行不存在视为 0）→ 才做余额判定
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_MIN_GENERATION_COST,
  DEFAULT_POINTS_PER_YUAN,
  INSUFFICIENT_POINTS_MESSAGE,
  NO_BALANCE_MESSAGE,
  consumePoints,
  ensureAccount,
  fetchBalance,
  type ConsumeResult,
} from '@/lib/points'

export { NO_BALANCE_MESSAGE, INSUFFICIENT_POINTS_MESSAGE }
export { fetchBalance }
export type { ConsumeResult }

// ────────────────────────────────────────────────────────────
// 积分汇率：1 元 = 20 积分 ⇒ 1 积分 = ¥0.05
//
// ⚠ 这里只是**兜底常量**。真实汇率在 public.point_config
//   （migrations/0012 种子值 20），改价请改数据库，不要改这行。
//   运行时要精确汇率请用 lib/points 的 getPointConfig()。
//
// 余额的最小记账单位是「积分」而不是「次数」：
//   不同字数/不同模型的真实成本能差一个数量级，按次计费必然亏损。
// ────────────────────────────────────────────────────────────
export const POINTS_PER_YUAN = DEFAULT_POINTS_PER_YUAN
export const YUAN_PER_POINT = 1 / POINTS_PER_YUAN

// ────────────────────────────────────────────────────────────
// DeepSeek 单价（元 / 百万 tokens）
//
// 官方自 2026-08-17 起峰谷定价：工作日 9:00-12:00、14:00-18:00 为高峰，
// 其余（含周末与法定节假日）为空闲，空闲价 = 高峰价的一半。
// 这里取「高峰/空闲均值」，避免同一篇文案早晚两个价、用户看不懂。
//
// 取值来源：DeepSeek 官方文档《模型 & 价格》deepseek-flash 档
//   · 输入（缓存命中） 空闲 0.02 / 高峰 0.04 → 均值 0.03
//   · 输入（缓存未命中）空闲 1    / 高峰 2    → 均值 1.5
//   · 输出              空闲 4    / 高峰 8    → 均值 6
// ⚠ 若你改用 deepseek-v4-pro（未命中 4.5/9、输出 13.5/27，约 3 倍价），
//   或官方再次调价，改这三个常量即可（单位统一是「元 / 百万 tokens」）。
// ────────────────────────────────────────────────────────────
export const PRICE_INPUT_CACHED_PER_MTOK = 0.03
export const PRICE_INPUT_MISS_PER_MTOK = 1.5
export const PRICE_OUTPUT_PER_MTOK = 6

/** 一次 LLM 调用的 token 用量（DeepSeek usage 字段的子集） */
export interface TokenUsage {
  /** 命中上下文硬盘缓存的输入 token（最便宜） */
  cachedTokens: number
  /** 未命中缓存的输入 token */
  missTokens: number
  /** 输出 token（最贵） */
  outputTokens: number
}

/** 零用量：LLM 未返回 usage 时使用（成本 0，最终按保底积分计费） */
export const ZERO_USAGE: TokenUsage = { cachedTokens: 0, missTokens: 0, outputTokens: 0 }

/** 一次生成的最低扣费：防止极小用量算出 0 积分，等于白送 */
export const MIN_GENERATION_COST = DEFAULT_MIN_GENERATION_COST

/** 原子扣减的默认扣费额（拿不到 usage 时的保底值，见 MIN_GENERATION_COST） */
export const DEFAULT_GENERATION_COST = MIN_GENERATION_COST

/** ensure_balance 的赠送额度默认值；真实值来自 point_config.REGISTER_BONUS_POINTS */
export const DEFAULT_GRANT = 20

/**
 * 把 token 用量换算成人民币成本（元）。
 * 缓存命中/未命中/输出三档分别计价——命中价只有未命中的 1/50，
 * 混在一起算会把长系统提示词的成本虚高几十倍。
 */
export function usageCostYuan(usage: TokenUsage): number {
  const mtok = 1_000_000
  const cached = Math.max(0, usage.cachedTokens) / mtok * PRICE_INPUT_CACHED_PER_MTOK
  const miss = Math.max(0, usage.missTokens) / mtok * PRICE_INPUT_MISS_PER_MTOK
  const out = Math.max(0, usage.outputTokens) / mtok * PRICE_OUTPUT_PER_MTOK
  return cached + miss + out
}

/**
 * 把 token 用量换算成应扣积分。
 *
 * 向上取整：宁可多收 1 积分，也不要把 0.4 积分抹成 0——
 * 抹零等于允许无限次"几乎免费"的生成，这是扣费场景里最贵的 bug。
 */
export function chargePointsForUsage(
  usage: TokenUsage,
  pointsPerYuan: number = POINTS_PER_YUAN
): number {
  const points = usageCostYuan(usage) * pointsPerYuan
  if (!Number.isFinite(points) || points <= 0) return MIN_GENERATION_COST
  return Math.max(MIN_GENERATION_COST, Math.ceil(points))
}

/** 多次 LLM 调用累加用量（同一请求内的系统提示词 + 正文两次调用） */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    cachedTokens: a.cachedTokens + b.cachedTokens,
    missTokens: a.missTokens + b.missTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

/**
 * 保证余额行存在并返回余额（含幂等注册赠送）。
 *
 * 内部走 grant_register_bonus：赠送会写入 point_ledger，
 * 且同一用户只会赠送一次（数据库唯一索引兜底）。
 */
export async function ensureBalance(
  supabase: SupabaseClient,
  userId: string,
  grant?: number
): Promise<number | null> {
  if (grant !== undefined) {
    // 显式指定赠金额度：走 RPC 原文（测试与管理员补发场景）
    const { data, error } = await supabase.rpc('grant_register_bonus', {
      p_user_id: userId,
      p_points: grant,
    })
    if (!error) {
      const r = (data ?? {}) as { ok?: unknown; balance?: unknown }
      if (r.ok === true) return Number(r.balance ?? 0)
    }
  }
  return ensureAccount(supabase, userId)
}

/**
 * 原子扣减余额并写积分流水（走 public.consume_points，行锁内判定）。
 *
 * 与旧实现的行为差异只有一处：现在会写 point_ledger，
 * 并且传入 refId 时重复调用只扣一次。
 *
 * 失败时不抛错——扣费失败不该让已经生成好的作品消失，调用方只记日志。
 */
export async function consumeBalance(
  supabase: SupabaseClient,
  userId: string,
  amount: number = DEFAULT_GENERATION_COST,
  opts: { refId?: string; description?: string } = {}
): Promise<ConsumeResult> {
  return consumePoints(supabase, userId, amount, {
    refId: opts.refId,
    source: 'generation',
    description: opts.description,
  })
}
