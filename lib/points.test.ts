// ============================================================
// lib/points —— 积分系统核心契约（Phase 1）
//
// 这里锁住三条最容易在重构中丢失的性质：
//   ① 金额→积分的换算是**唯一口径**，向下取整、浮点不漂移
//   ② 配置读不到时回落到兜底值，绝不抛错（可用性问题不得伪装成业务故障）
//   ③ 幂等语义由调用方正确传达：duplicated=true 时不许再算一次账
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_POINTS_PER_YUAN,
  FALLBACK_CONFIG,
  __resetConfigCache,
  amountForPoints,
  consumePoints,
  ensureAccount,
  getPointConfig,
  normalizeLedgerRow,
  pointsForAmount,
} from './points'

/**
 * 鸭子类型 mock：同时覆盖两种调用形态
 *   · await from('point_config').select('key, value')  —— 配置读取
 *   · await from('user_balances').select().eq().maybeSingle() —— 余额读取
 */
function fakeClient(impl: {
  select?: (table: string) => Promise<{ data: unknown; error: unknown }>
  maybeSingle?: (table: string) => Promise<{ data: unknown; error: unknown }>
  rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
}): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => {
        const direct = impl.select?.(table) ?? Promise.resolve({ data: null, error: null })
        // Promise 上挂 .eq()，让同一份 mock 也能走 maybeSingle 链
        return Object.assign(direct, {
          eq: () => ({
            maybeSingle: () =>
              impl.maybeSingle?.(table) ?? Promise.resolve({ data: null, error: null }),
          }),
        })
      },
    }),
    rpc: (fn: string, args: Record<string, unknown>) =>
      impl.rpc?.(fn, args) ?? Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient
}

beforeEach(() => {
  __resetConfigCache()
})

describe('pointsForAmount：金额 → 积分（唯一换算口径）', () => {
  it('默认汇率下 10 元 = 200 积分', () => {
    expect(pointsForAmount(10, DEFAULT_POINTS_PER_YUAN)).toBe(200)
  })

  it('需求里的档位全对得上（5/10/20/50/100 元）', () => {
    const table: [number, number][] = [
      [5, 100],
      [10, 200],
      [20, 400],
      [50, 1000],
      [100, 2000],
    ]
    for (const [yuan, expected] of table) {
      expect(pointsForAmount(yuan, 20)).toBe(expected)
    }
  })

  it('改价只需改汇率：1 元 = 15 积分时 10 元 = 150 积分', () => {
    expect(pointsForAmount(10, 15)).toBe(150)
  })

  it('向下取整：宁可少给 1 积分，也不因浮点尾巴多送', () => {
    expect(pointsForAmount(0.99, 20)).toBe(19) // 19.8 → 19
  })

  it('浮点不漂移：0.1+0.2 这类输入不会算出 6.000000000000001', () => {
    expect(pointsForAmount(0.1 + 0.2, 20)).toBe(6)
  })

  it('负数与非法值一律 0，绝不产出负积分', () => {
    expect(pointsForAmount(-10, 20)).toBe(0)
    expect(pointsForAmount(Number.NaN, 20)).toBe(0)
    expect(pointsForAmount(10, Number.NaN)).toBe(0)
  })
})

describe('amountForPoints：积分 → 金额（展示用）', () => {
  it('20 积分 = ¥1', () => {
    expect(amountForPoints(20, 20)).toBe(1)
  })

  it('汇率为 0 时返回 0，不产生 Infinity', () => {
    expect(amountForPoints(20, 0)).toBe(0)
  })
})

describe('getPointConfig：配置读取与回落', () => {
  it('正常解析：numeric 以字符串返回也要变成数字', async () => {
    const c = fakeClient({
      select: async () => ({
        data: [
          { key: 'POINTS_PER_YUAN', value: '20' },
          { key: 'MIN_RECHARGE_AMOUNT', value: 5 },
          { key: 'AI_PRECHARGE_GENERATION', value: '12' },
        ],
        error: null,
      }),
    })
    const cfg = await getPointConfig(c)
    expect(cfg.pointsPerYuan).toBe(20)
    expect(cfg.minRechargeAmount).toBe(5)
    expect(cfg.precharge.generation).toBe(12)
    // 没返回的键用兜底，不出现 undefined
    expect(cfg.registerBonusPoints).toBe(FALLBACK_CONFIG.registerBonusPoints)
  })

  it('红线：表报错 → 回落兜底配置，不抛异常', async () => {
    const c = fakeClient({
      select: async () => ({ data: null, error: { code: '42P01', message: 'relation missing' } }),
    })
    await expect(getPointConfig(c)).resolves.toEqual(FALLBACK_CONFIG)
  })

  it('红线：查到空表 → 回落兜底配置（迁移没跑不该让生成链路挂掉）', async () => {
    const c = fakeClient({ select: async () => ({ data: [], error: null }) })
    await expect(getPointConfig(c)).resolves.toEqual(FALLBACK_CONFIG)
  })

  it('脏值（负数/非数字）被兜底顶掉', async () => {
    const c = fakeClient({
      select: async () => ({
        data: [{ key: 'POINTS_PER_YUAN', value: -5 }],
        error: null,
      }),
    })
    const cfg = await getPointConfig(c)
    expect(cfg.pointsPerYuan).toBe(FALLBACK_CONFIG.pointsPerYuan)
  })

  it('60 秒内复用缓存：第二次不再打数据库', async () => {
    let calls = 0
    const c = fakeClient({
      select: async () => {
        calls += 1
        return { data: [{ key: 'POINTS_PER_YUAN', value: 20 }], error: null }
      },
    })
    await getPointConfig(c)
    await getPointConfig(c)
    expect(calls).toBe(1)
  })
})

describe('ensureAccount：开户 + 幂等赠送', () => {
  it('首次赠送 granted:true 并返回余额', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: true, granted: true, points: 20, balance: 20 }, error: null }),
    })
    await expect(ensureAccount(c, 'u1')).resolves.toBe(20)
  })

  it('重复调用 granted:false，余额不变（幂等）', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: true, granted: false, points: 0, balance: 20 }, error: null }),
    })
    await expect(ensureAccount(c, 'u1')).resolves.toBe(20)
  })

  it('RPC 失败 → 回落到只读查询，返回 null 而不是 0', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: null, error: { message: 'function does not exist' } }),
      // fetchBalance 走 maybeSingle，这里 mock 不到 → data null → 0
    })
    await expect(ensureAccount(c, 'u1')).resolves.toBe(0)
  })
})

describe('consumePoints：原子扣费 + 幂等', () => {
  it('首次扣费：ok + 最新余额', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: true, duplicated: false, balance: 190 }, error: null }),
    })
    await expect(consumePoints(c, 'u1', 10, { refId: 'order-1' })).resolves.toEqual({
      ok: true,
      balance: 190,
      duplicated: false,
    })
  })

  it('重复同一 refId：duplicated=true，不再扣第二次', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: true, duplicated: true, balance: 190 }, error: null }),
    })
    await expect(consumePoints(c, 'u1', 10, { refId: 'order-1' })).resolves.toMatchObject({
      ok: true,
      duplicated: true,
      balance: 190,
    })
  })

  it('余额不足 → 不动账（返回 insufficient_balance）', async () => {
    const c = fakeClient({
      rpc: async () => ({
        data: { ok: false, code: 'insufficient_balance', balance: 3 },
        error: null,
      }),
    })
    await expect(consumePoints(c, 'u1', 10)).resolves.toMatchObject({
      ok: false,
      code: 'insufficient_balance',
      balance: 3,
    })
  })

  it('红线：RPC 报错不抛异常，降级成 code=error', async () => {
    const c = fakeClient({ rpc: async () => ({ data: null, error: { message: 'network' } }) })
    await expect(consumePoints(c, 'u1', 1)).resolves.toEqual({ ok: false, code: 'error' })
  })

  it('未知 code 一律归并为 error，不泄漏给上层', async () => {
    const c = fakeClient({ rpc: async () => ({ data: { ok: false, code: '???' }, error: null }) })
    await expect(consumePoints(c, 'u1', 1)).resolves.toMatchObject({ code: 'error' })
  })

  it('refId 与描述原样透传给 RPC（幂等键不能丢）', async () => {
    let captured: Record<string, unknown> = {}
    const c = fakeClient({
      rpc: async (_fn, args) => {
        captured = args
        return { data: { ok: true, balance: 90 }, error: null }
      },
    })
    await consumePoints(c, 'u1', 10, { refId: 'work-123', description: '正文生成' })
    expect(captured.p_reference_id).toBe('work-123')
    expect(captured.p_description).toBe('正文生成')
    expect(captured.p_amount).toBe(10)
  })
})

describe('normalizeLedgerRow：脏数据一律丢弃', () => {
  it('正常行', () => {
    const e = normalizeLedgerRow({
      id: 'l1',
      user_id: 'u1',
      type: 'RECHARGE',
      amount: 200,
      balance_before: 20,
      balance_after: 220,
      source: 'recharge',
      reference_id: 'R123',
      description: '充值',
      created_at: '2026-09-24T00:00:00Z',
    })
    expect(e).toMatchObject({ type: 'RECHARGE', amount: 200, balanceAfter: 220 })
  })

  it('numeric 以字符串返回时要解析成数字', () => {
    const e = normalizeLedgerRow({
      id: 'l1',
      user_id: 'u1',
      type: 'AI_CONSUMPTION',
      amount: '-10',
      balance_before: '30',
      balance_after: '20',
    })
    expect(e?.amount).toBe(-10)
    expect(e?.balanceAfter).toBe(20)
  })

  it('非法 type / 缺字段 → null（宁可少展示一条，也不把 undefined 渲染给用户）', () => {
    expect(normalizeLedgerRow({ id: 'l1', user_id: 'u1', type: 'WHATEVER', amount: 1, balance_before: 0, balance_after: 1 })).toBeNull()
    expect(normalizeLedgerRow({ id: 'l1', user_id: 'u1', type: 'RECHARGE' })).toBeNull()
    expect(normalizeLedgerRow({})).toBeNull()
  })
})
