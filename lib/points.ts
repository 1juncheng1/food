// ============================================================
// lib/points —— 积分系统的唯一口径（Phase 1）
//
// 这个文件解决的是 Phase 0 审计里最硬的一条问题：
//   **此前余额是唯一事实，任何变动都不留痕。**
// 现在的关系是：余额 = 流水的累积结果。余额负责快，流水负责真。
//
// 三条红线和旧 lib/balance 一脉相承，另外加了两条：
//   ① 读不到余额 ≠ 余额为 0（fail-open，不冤枉用户）
//   ② 扣费失败不得抛错（作品已经生成好了，不能因为记账失败让用户丢作品）
//   ③ **积分恒由服务端计算**：任何加积分的接口都不接受客户端传的积分值
//   ④ **幂等由数据库唯一索引兜底**，不靠"先查后写"的应用层判断
//
// 汇率与门槛全部来自 public.point_config（见 migrations/0012），
// 下面的 DEFAULT_* 只是「配置表读不到时的兜底」，不是推荐值。
// 改价请改数据库，不要改这里。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

/** 余额为 0 时给用户的统一文案（沿用旧文案，前端两处已引用） */
export const NO_BALANCE_MESSAGE = '当前没有余额，请充值'
/** AI 调用前的余额不足文案：明确告诉用户下一步做什么 */
export const INSUFFICIENT_POINTS_MESSAGE = '当前积分不足，请充值后继续创作。'

// ────────────────────────────────────────────────────────────
// 兜底配置：仅用于 point_config 读不到（迁移未跑/数据库抖动）时。
// 与 SQL 里的 insert 种子保持一致 —— 两处不一致会算出两套价。
// ────────────────────────────────────────────────────────────
export const DEFAULT_POINTS_PER_YUAN = 20
export const DEFAULT_MIN_RECHARGE_AMOUNT = 5
export const DEFAULT_MAX_RECHARGE_AMOUNT = 5000
export const DEFAULT_REGISTER_BONUS_POINTS = 20
export const DEFAULT_MIN_GENERATION_COST = 1

/** 配置键（与 point_config.key 对齐，写错 key 会静默回落到兜底值） */
export const CONFIG_KEYS = {
  POINTS_PER_YUAN: 'POINTS_PER_YUAN',
  MIN_RECHARGE_AMOUNT: 'MIN_RECHARGE_AMOUNT',
  MAX_RECHARGE_AMOUNT: 'MAX_RECHARGE_AMOUNT',
  REGISTER_BONUS_POINTS: 'REGISTER_BONUS_POINTS',
  MIN_GENERATION_COST: 'MIN_GENERATION_COST',
  AI_PRECHARGE_GENERATION: 'AI_PRECHARGE_GENERATION',
  AI_PRECHARGE_BLUEPRINT: 'AI_PRECHARGE_BLUEPRINT',
  AI_PRECHARGE_DIAGNOSIS: 'AI_PRECHARGE_DIAGNOSIS',
  AI_PRECHARGE_CHAT: 'AI_PRECHARGE_CHAT',
  AI_PRECHARGE_ANALYSIS: 'AI_PRECHARGE_ANALYSIS',
  AI_PRECHARGE_KNOWLEDGE: 'AI_PRECHARGE_KNOWLEDGE',
} as const

export type ConfigKey = (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS]

/** 一份完整的积分配置快照 */
export interface PointConfig {
  /** 1 元 = ? 积分 */
  pointsPerYuan: number
  /** 最低充值金额（元） */
  minRechargeAmount: number
  /** 单笔充值上限（元）：人工审核模式下，超额多半是输错了 */
  maxRechargeAmount: number
  /** 注册赠送积分 */
  registerBonusPoints: number
  /** 单次 AI 消费保底积分 */
  minGenerationCost: number
  /** 各类 AI 能力的调用前门槛（预扣口径） */
  precharge: {
    generation: number
    blueprint: number
    diagnosis: number
    chat: number
    analysis: number
    knowledge: number
  }
}

/** 配置全丢时的兜底快照 */
export const FALLBACK_CONFIG: PointConfig = {
  pointsPerYuan: DEFAULT_POINTS_PER_YUAN,
  minRechargeAmount: DEFAULT_MIN_RECHARGE_AMOUNT,
  maxRechargeAmount: DEFAULT_MAX_RECHARGE_AMOUNT,
  registerBonusPoints: DEFAULT_REGISTER_BONUS_POINTS,
  minGenerationCost: DEFAULT_MIN_GENERATION_COST,
  precharge: { generation: 10, blueprint: 5, diagnosis: 5, chat: 3, analysis: 5, knowledge: 3 },
}

// ── 进程内短缓存：配置读一次管 60 秒 ──────────────────────────
// 每个 AI 请求都查一次配置表是浪费；配置本身极低频改动，
// 60 秒的窗口足够管理员在后台改完价看到生效，又不至于拖慢热路径。
const CONFIG_TTL_MS = 60_000
let configCache: { at: number; data: PointConfig } | null = null

/** 仅供测试：清空配置缓存 */
export function __resetConfigCache(): void {
  configCache = null
}

/**
 * 读取积分配置。
 *
 * 读不到（表不存在/报错）时**整体回落到 FALLBACK_CONFIG**，
 * 而不是抛错：配置缺失不该让生成链路挂掉，那和"网络故障被判定为未登录"
 * 是同一类把可用性问题伪装成业务故障的错误。
 */
export async function getPointConfig(supabase: SupabaseClient): Promise<PointConfig> {
  const now = Date.now()
  if (configCache && now - configCache.at < CONFIG_TTL_MS) return configCache.data

  try {
    const { data, error } = await supabase.from('point_config').select('key, value')
    if (error || !Array.isArray(data) || data.length === 0) {
      if (error) console.error(`[points] 读取配置失败(${error.code ?? '?'}):`, error.message)
      return FALLBACK_CONFIG
    }
    const raw = new Map<string, number>()
    for (const row of data as { key?: unknown; value?: unknown }[]) {
      const k = typeof row.key === 'string' ? row.key : ''
      const v = toNumber(row.value)
      if (k && v !== null) raw.set(k, v)
    }
    const cfg: PointConfig = {
      pointsPerYuan: pick(raw, CONFIG_KEYS.POINTS_PER_YUAN, DEFAULT_POINTS_PER_YUAN),
      minRechargeAmount: pick(raw, CONFIG_KEYS.MIN_RECHARGE_AMOUNT, DEFAULT_MIN_RECHARGE_AMOUNT),
      maxRechargeAmount: pick(raw, CONFIG_KEYS.MAX_RECHARGE_AMOUNT, DEFAULT_MAX_RECHARGE_AMOUNT),
      registerBonusPoints: pick(raw, CONFIG_KEYS.REGISTER_BONUS_POINTS, DEFAULT_REGISTER_BONUS_POINTS),
      minGenerationCost: pick(raw, CONFIG_KEYS.MIN_GENERATION_COST, DEFAULT_MIN_GENERATION_COST),
      precharge: {
        generation: pick(raw, CONFIG_KEYS.AI_PRECHARGE_GENERATION, 10),
        blueprint: pick(raw, CONFIG_KEYS.AI_PRECHARGE_BLUEPRINT, 5),
        diagnosis: pick(raw, CONFIG_KEYS.AI_PRECHARGE_DIAGNOSIS, 5),
        chat: pick(raw, CONFIG_KEYS.AI_PRECHARGE_CHAT, 3),
        analysis: pick(raw, CONFIG_KEYS.AI_PRECHARGE_ANALYSIS, 5),
        knowledge: pick(raw, CONFIG_KEYS.AI_PRECHARGE_KNOWLEDGE, 3),
      },
    }
    configCache = { at: now, data: cfg }
    return cfg
  } catch (e) {
    console.error('[points] 读取配置异常:', e)
    return FALLBACK_CONFIG
  }
}

function pick(map: Map<string, number>, key: string, fallback: number): number {
  const v = map.get(key)
  return v !== undefined && Number.isFinite(v) && v >= 0 ? v : fallback
}

/**
 * 金额 → 积分。
 *
 * 这是「用户付了多少钱」到「用户拿到多少积分」的**唯一换算函数**，
 * 充值确认、前端"预计获得"展示都必须走它，避免两处各算一遍出现口径分裂。
 *
 * 向下取整：宁可少给 1 积分，也不要因为浮点误差多送
 * （0.9999 元 × 20 = 19.998 → 19，比 20 保守且可预期）。
 */
export function pointsForAmount(amountYuan: number, pointsPerYuan: number): number {
  if (!Number.isFinite(amountYuan) || !Number.isFinite(pointsPerYuan)) return 0
  const raw = Math.max(0, amountYuan) * Math.max(0, pointsPerYuan)
  return Math.floor(round6(raw))
}

/** 积分 → 金额（展示用：告诉用户这些积分值多少钱） */
export function amountForPoints(points: number, pointsPerYuan: number): number {
  if (!Number.isFinite(points) || !pointsPerYuan) return 0
  return round6(Math.max(0, points) / Math.max(0, pointsPerYuan))
}

/** 抹掉二进制浮点尾巴（0.1*3 = 0.30000000000000004 之类） */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

// ────────────────────────────────────────────────────────────
// 流水类型（与 SQL check 约束一一对应，改这里必须同步改迁移）
// ────────────────────────────────────────────────────────────
export const LEDGER_TYPES = [
  'REGISTER_BONUS',
  'RECHARGE',
  'AI_CONSUMPTION',
  'MANUAL_ADJUSTMENT',
  'REFUND',
] as const

export type LedgerType = (typeof LEDGER_TYPES)[number]

export interface LedgerEntry {
  id: string
  userId: string
  type: LedgerType
  /** 正=入账，负=扣减 */
  amount: number
  balanceBefore: number
  balanceAfter: number
  source: string
  referenceId: string | null
  description: string | null
  createdAt: string
}

/**
 * 读取我自己的积分流水（新的在前）。
 *
 * 只查自己的：RLS 已限定 user_id = auth.uid()，这里再显式限定一次（纵深防御）。
 * 查询失败返回空数组而不是抛错——流水页挂掉不该影响创作主流程。
 */
export async function fetchMyLedger(
  supabase: SupabaseClient,
  userId: string,
  limit = 50
): Promise<LedgerEntry[]> {
  const { data, error } = await supabase
    .from('point_ledger')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100))

  if (error) {
    console.error(`[points] 读取积分流水失败(${error.code ?? '?'}):`, error.message)
    return []
  }
  if (!Array.isArray(data)) return []
  return data
    .map((r) => normalizeLedgerRow(r as Record<string, unknown>))
    .filter((e): e is LedgerEntry => e !== null)
}

/**
 * 读取余额。
 * @returns 余额数字；**null 表示读取失败**（不是 0），调用方应放行而非拦截。
 */
export async function fetchBalance(
  supabase: SupabaseClient,
  userId: string
): Promise<number | null> {
  const { data, error } = await supabase
    .from('user_balances')
    .select('balance')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    // 42P01 = 迁移没跑。此时判"无余额"会全站锁死，必须放行并留日志。
    console.error(`[points] 读取余额失败(${error.code ?? '?'}):`, error.message)
    return null
  }
  return toNumber(data?.balance) ?? 0
}

/**
 * 开户 + 幂等赠送注册积分。
 *
 * 可以反复调用：真正赠送只会发生一次（数据库唯一索引兜底）。
 * @returns 赠送后的余额；null = 读取失败
 */
export async function ensureAccount(
  supabase: SupabaseClient,
  userId: string
): Promise<number | null> {
  const { data, error } = await supabase.rpc('grant_register_bonus', {
    p_user_id: userId,
    p_points: null,
  })
  if (error) {
    console.error('[points] grant_register_bonus 失败:', error.message)
    return fetchBalance(supabase, userId)
  }
  const r = (data ?? {}) as { ok?: unknown; balance?: unknown; granted?: unknown }
  if (r.ok === true) return toNumber(r.balance) ?? (await fetchBalance(supabase, userId))
  return fetchBalance(supabase, userId)
}

export type ConsumeResult =
  | { ok: true; balance: number; duplicated: boolean }
  | { ok: false; code: 'insufficient_balance' | 'unauthenticated' | 'bad_amount' | 'error'; balance?: number }

/**
 * 原子扣减积分并写流水。
 *
 * `refId` 是幂等键：同一业务号重复调用（重试、并发、前端重发）只会扣一次，
 * 第二次返回 `duplicated: true` 与当时的余额，绝不二次扣减。
 *
 * 失败时不抛错——扣费失败不该让已经生成好的作品消失，调用方只记日志。
 */
export async function consumePoints(
  supabase: SupabaseClient,
  userId: string,
  amount: number,
  opts: {
    /** 幂等业务号（强烈建议传；不传就失去重复保护） */
    refId?: string
    source?: string
    description?: string
  } = {}
): Promise<ConsumeResult> {
  const { data, error } = await supabase.rpc('consume_points', {
    p_amount: amount,
    p_reference_id: opts.refId ?? null,
    p_source: opts.source ?? 'generation',
    p_description: opts.description ?? null,
    p_user_id: userId,
  })
  if (error) {
    console.error('[points] consume_points 失败:', error.message)
    return { ok: false, code: 'error' }
  }
  const r = (data ?? {}) as { ok?: unknown; code?: unknown; balance?: unknown; duplicated?: unknown }
  if (r.ok === true) {
    return { ok: true, balance: toNumber(r.balance) ?? 0, duplicated: r.duplicated === true }
  }
  const code = r.code
  return {
    ok: false,
    code:
      code === 'insufficient_balance' ||
      code === 'unauthenticated' ||
      code === 'bad_amount'
        ? code
        : 'error',
    balance: toNumber(r.balance) ?? undefined,
  }
}

export type RefundResult =
  | { ok: true; balance: number; refunded: number; duplicated: boolean }
  | { ok: false; code: 'forbidden' | 'bad_amount' | 'error' }

/**
 * 退还积分并写 REFUND 流水（AI 预扣结算的差额退回 / 调用失败全额退）。
 *
 * 与 consumePoints 对称：同一个 `refId` 只退一次。
 * 余额**可以**因为退款超过历史峰值——这是正常的（比如失败全额退），
 * 它不会凭空造钱，退的本来就是刚扣走的那些。
 */
export async function refundPoints(
  supabase: SupabaseClient,
  userId: string,
  amount: number,
  opts: { refId?: string; description?: string } = {}
): Promise<RefundResult> {
  const { data, error } = await supabase.rpc('refund_points', {
    p_user_id: userId,
    p_amount: Math.max(0, Math.trunc(amount)),
    p_reference_id: opts.refId ?? null,
    p_description: opts.description ?? null,
  })
  if (error) {
    console.error('[points] refund_points 失败:', error.message)
    return { ok: false, code: 'error' }
  }
  const r = (data ?? {}) as {
    ok?: unknown
    code?: unknown
    balance?: unknown
    refunded?: unknown
    duplicated?: unknown
  }
  if (r.ok === true) {
    return {
      ok: true,
      balance: toNumber(r.balance) ?? 0,
      refunded: toNumber(r.refunded) ?? 0,
      duplicated: r.duplicated === true,
    }
  }
  const code = r.code
  return {
    ok: false,
    code: code === 'forbidden' || code === 'bad_amount' ? code : 'error',
  }
}

/** numeric 经 PostgREST 回来可能是 number 也可能是 string，统一成 number */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 把数据库行映射成 LedgerEntry（脏数据一律丢弃，不把 undefined 渲染给用户） */
export function normalizeLedgerRow(row: Record<string, unknown>): LedgerEntry | null {
  const id = typeof row.id === 'string' ? row.id : ''
  const userId = typeof row.user_id === 'string' ? row.user_id : ''
  const type = row.type
  const amount = toNumber(row.amount)
  const before = toNumber(row.balance_before)
  const after = toNumber(row.balance_after)
  if (!id || !userId || amount === null || before === null || after === null) return null
  if (typeof type !== 'string' || !(LEDGER_TYPES as readonly string[]).includes(type)) return null
  return {
    id,
    userId,
    type: type as LedgerType,
    amount,
    balanceBefore: before,
    balanceAfter: after,
    source: typeof row.source === 'string' ? row.source : 'system',
    referenceId: typeof row.reference_id === 'string' ? row.reference_id : null,
    description: typeof row.description === 'string' ? row.description : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
  }
}
