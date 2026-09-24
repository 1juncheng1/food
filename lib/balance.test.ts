// ============================================================
// lib/balance —— 余额读写的两条红线
//
// ① 读不到余额 ≠ 余额为 0。
//    这条一旦被抹平，数据库抖动/迁移没跑时，用户会看到"当前没有余额，请充值"——
//    和"网络故障被当成登录过期"是同一类事故：把可用性问题伪装成业务判定。
//
// ② 扣费失败不得抛错。
//    作品已经生成好了，扣费只是记账；记账失败要留日志，不能让用户丢作品。
//
// 另外锁住 numeric 的双形态：PostgREST 可能回 number 也可能回 string，
// 两种都要解析成数字，否则 '0' 会被当成真值、'12.50' 会被当成 NaN。
// ============================================================

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  POINTS_PER_YUAN,
  YUAN_PER_POINT,
  ZERO_USAGE,
  addUsage,
  chargePointsForUsage,
  consumeBalance,
  ensureBalance,
  fetchBalance,
  usageCostYuan,
} from './balance'

/** 只用到了 from/rpc 两个入口，鸭子类型足够（不必 mock 整个 supabase-js） */
function fakeClient(impl: {
  maybeSingle?: () => Promise<{ data: unknown; error: unknown }>
  rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
}): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: impl.maybeSingle ?? (async () => ({ data: null, error: null })),
        }),
      }),
    }),
    rpc: (fn: string, args: Record<string, unknown>) =>
      impl.rpc?.(fn, args) ?? (async () => ({ data: null, error: null })),
  } as unknown as SupabaseClient
}

describe('fetchBalance：读取余额', () => {
  it('正常返回数字', async () => {
    const c = fakeClient({ maybeSingle: async () => ({ data: { balance: 12 }, error: null }) })
    await expect(fetchBalance(c, 'u1')).resolves.toBe(12)
  })

  it('numeric 以字符串返回时也要解析成数字', async () => {
    const c = fakeClient({ maybeSingle: async () => ({ data: { balance: '12.50' }, error: null }) })
    await expect(fetchBalance(c, 'u1')).resolves.toBe(12.5)
  })

  it('行不存在（未开户）→ 0，而不是失败', async () => {
    const c = fakeClient({ maybeSingle: async () => ({ data: null, error: null }) })
    await expect(fetchBalance(c, 'u1')).resolves.toBe(0)
  })

  it('红线①：查询报错 → null（调用方必须放行，不得当成 0 拦截用户）', async () => {
    const c = fakeClient({
      maybeSingle: async () => ({ data: null, error: { code: '42P01', message: 'relation missing' } }),
    })
    await expect(fetchBalance(c, 'u1')).resolves.toBeNull()
  })
})

describe('ensureBalance：开户并读取', () => {
  it('rpc 返回余额', async () => {
    // 新口径：grant_register_bonus 返回 jsonb { ok, granted, points, balance }
    const c = fakeClient({ rpc: async () => ({ data: { ok: true, balance: 20 }, error: null }) })
    await expect(ensureBalance(c, 'u1')).resolves.toBe(20)
  })

  it('rpc 失败 → 回落到只读查询，不抛错', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: null, error: { message: 'function does not exist' } }),
      maybeSingle: async () => ({ data: { balance: 5 }, error: null }),
    })
    await expect(ensureBalance(c, 'u1')).resolves.toBe(5)
  })
})

describe('consumeBalance：原子扣费', () => {
  it('扣费成功 → ok + 最新余额', async () => {
    const c = fakeClient({ rpc: async () => ({ data: { ok: true, balance: 19 }, error: null }) })
    await expect(consumeBalance(c, 'u1', 1)).resolves.toMatchObject({ ok: true, balance: 19 })
  })

  it('余额不足 → ok:false + insufficient_balance（不动账）', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: false, code: 'insufficient_balance', balance: 0 }, error: null }),
    })
    expect(await consumeBalance(c, 'u1', 1)).toMatchObject({
      ok: false,
      code: 'insufficient_balance',
      balance: 0,
    })
  })

  it('红线②：rpc 报错 → 返回 error 结果，不抛异常', async () => {
    const c = fakeClient({ rpc: async () => ({ data: null, error: { message: 'network' } }) })
    await expect(consumeBalance(c, 'u1')).resolves.toEqual({ ok: false, code: 'error' })
  })

  it('默认扣 1 额度', async () => {
    let captured: Record<string, unknown> = {}
    const c = fakeClient({
      rpc: async (_fn, args) => {
        captured = args
        return { data: { ok: true, balance: 19 }, error: null }
      },
    })
    await consumeBalance(c, 'u1')
    expect(captured.p_amount).toBe(1)
  })
})

describe('积分汇率：1 元 = 20 积分', () => {
  it('1 元 = 20 积分，1 积分 = ¥0.05', () => {
    // ⚠ 这里是兜底常量；生产真实值来自 public.point_config（见 lib/points）
    expect(POINTS_PER_YUAN).toBe(20)
    expect(YUAN_PER_POINT).toBeCloseTo(0.05, 6)
  })

  it('成本按「缓存命中 / 未命中 / 输出」三档分别计价', () => {
    const cost = usageCostYuan({
      cachedTokens: 1_000_000,
      missTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    // 0.03 + 1.5 + 6
    expect(cost).toBeCloseTo(7.53, 6)
  })

  it('缓存命中比未命中便宜一个数量级（不能混算）', () => {
    const cached = usageCostYuan({ cachedTokens: 1_000_000, missTokens: 0, outputTokens: 0 })
    const miss = usageCostYuan({ cachedTokens: 0, missTokens: 1_000_000, outputTokens: 0 })
    expect(cached).toBeCloseTo(0.03, 6)
    expect(miss).toBeCloseTo(1.5, 6)
    expect(miss / cached).toBe(50)
  })

  it('向上取整：宁可多收 1 积分，也不许把 0.9 积分抹成 0', () => {
    // 典型短稿：输入 5k（未命中）+ 2k（缓存）+ 输出 2.5k ≈ ¥0.0226 ≈ 0.9 积分
    const points = chargePointsForUsage({
      cachedTokens: 2_000,
      missTokens: 5_000,
      outputTokens: 2_500,
    })
    expect(points).toBe(1)
  })

  it('长文按量多扣：同样是 20 积分，3000 字长文比短稿贵', () => {
    const long = chargePointsForUsage({
      cachedTokens: 2_000,
      missTokens: 10_000,
      outputTokens: 9_000,
    })
    // (10k*1.5 + 2k*0.03 + 9k*6)/1e6 = 0.06906 元 → ×20 = 1.38 → 2 积分
    expect(long).toBe(2)
  })

  it('红线：零用量也至少扣 1 积分（兜底防白嫖）', () => {
    expect(chargePointsForUsage(ZERO_USAGE)).toBe(1)
  })

  it('addUsage 累加同一请求内的多次 LLM 调用', () => {
    const total = addUsage(
      { cachedTokens: 1, missTokens: 2, outputTokens: 3 },
      { cachedTokens: 10, missTokens: 20, outputTokens: 30 }
    )
    expect(total).toEqual({ cachedTokens: 11, missTokens: 22, outputTokens: 33 })
  })
})
