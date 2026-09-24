// ============================================================
// lib/aiCost —— AI 消费计费契约（Phase 4）
//
// 这里锁住需求 §17-19 的三条：
//   ① 余额不足时**绝不发起** LLM 调用（预扣在调用前，且失败可判定）
//   ② 计费按**真实 token 用量**，不是按次一口价
//   ③ 实际 < 预扣必须退回（预扣不等于涨价），失败必须全额退
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { __resetConfigCache } from './points'
import {
  hasEnoughFor,
  prechargeFor,
  refundAiCost,
  reserveAiCost,
  settleAiCost,
} from './aiCost'

function fakeClient(impl: {
  select?: (table: string) => Promise<{ data: unknown; error: unknown }>
  rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
}): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => {
        const direct = impl.select?.(table) ?? Promise.resolve({ data: null, error: null })
        return Object.assign(direct, {
          eq: () => ({
            maybeSingle: () => impl.select?.(table) ?? Promise.resolve({ data: null, error: null }),
          }),
        })
      },
    }),
    rpc: (fn: string, args: Record<string, unknown>) =>
      impl.rpc?.(fn, args) ?? Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient
}

/** point_config 只有汇率：预扣档位走兜底（generation=10） */
function configClient(): SupabaseClient {
  return fakeClient({
    select: async (t) =>
      t === 'point_config'
        ? { data: [{ key: 'POINTS_PER_YUAN', value: 20 }], error: null }
        : { data: null, error: null },
  })
}

beforeEach(() => {
  __resetConfigCache()
})

describe('prechargeFor：调用前门槛', () => {
  it('generation 默认 10 积分（来自配置/兜底）', async () => {
    await expect(prechargeFor(configClient(), 'generation')).resolves.toBe(10)
  })

  it('读不到配置时回落兜底值，不抛错', async () => {
    const c = fakeClient({})
    await expect(prechargeFor(c, 'blueprint')).resolves.toBe(5)
  })
})

describe('hasEnoughFor：调用前预检（只查不扣）', () => {
  it('余额够 → ok', async () => {
    const c = fakeClient({
      select: async (t) =>
        t === 'point_config'
          ? { data: [{ key: 'POINTS_PER_YUAN', value: 20 }], error: null }
          : { data: { balance: 50 }, error: null },
    })
    await expect(hasEnoughFor(c, 'u1', 'generation')).resolves.toMatchObject({ ok: true })
  })

  it('余额不够 → 不 ok，并带回所需积分', async () => {
    const c = fakeClient({
      select: async (t) =>
        t === 'point_config'
          ? { data: [{ key: 'POINTS_PER_YUAN', value: 20 }], error: null }
          : { data: { balance: 3 }, error: null },
    })
    await expect(hasEnoughFor(c, 'u1', 'generation')).resolves.toMatchObject({
      ok: false,
      required: 10,
      balance: 3,
    })
  })

  it('★读不到余额 → 放行（fail-open，不冤枉用户）', async () => {
    const c = fakeClient({
      select: async (t) =>
        t === 'point_config'
          ? { data: [{ key: 'POINTS_PER_YUAN', value: 20 }], error: null }
          : { data: null, error: { message: 'relation missing', code: '42P01' } },
    })
    await expect(hasEnoughFor(c, 'u1', 'generation')).resolves.toMatchObject({
      ok: true,
      balance: null,
    })
  })
})

describe('reserveAiCost：调用前预扣', () => {
  it('成功：扣掉预扣额度，幂等键带 :reserve', async () => {
    let captured: Record<string, unknown> = {}
    const c = fakeClient({
      select: async (t) =>
        t === 'point_config'
          ? { data: [{ key: 'POINTS_PER_YUAN', value: 20 }], error: null }
          : { data: null, error: null },
      rpc: async (_fn, args) => {
        captured = args
        return { data: { ok: true, balance: 40 }, error: null }
      },
    })
    const r = await reserveAiCost({ supabase: c, userId: 'u1', ability: 'generation', refId: 'g1' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.reserved).toBe(10)
    expect(captured.p_reference_id).toBe('g1:reserve')
    expect(captured.p_amount).toBe(10)
  })

  it('★重复预扣：不二次扣钱，且 reserved 必须是 0', async () => {
    // 这条守的是一条真实的资金事故：
    // reserved 会被调用方拿去结算，若重复预扣时谎报"我扣了 amount"，
    // 结算就会把这笔根本没扣过的钱"退"给用户 → 凭空造出积分。
    const c = fakeClient({
      select: async (t) =>
        t === 'point_config'
          ? { data: [{ key: 'POINTS_PER_YUAN', value: 20 }], error: null }
          : { data: null, error: null },
      rpc: async () => ({ data: { ok: true, balance: 40, duplicated: true }, error: null }),
    })
    const r = await reserveAiCost({ supabase: c, userId: 'u1', ability: 'generation', refId: 'g1' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.duplicated).toBe(true)
      expect(r.reserved).toBe(0) // ← 关键：绝不能是 10
    }
  })

  it('★余额不足 → insufficient_balance + 所需积分（调用方据此拒绝发起 LLM）', async () => {
    const c = fakeClient({
      select: async (t) =>
        t === 'point_config'
          ? { data: [{ key: 'POINTS_PER_YUAN', value: 20 }], error: null }
          : { data: null, error: null },
      rpc: async () => ({ data: { ok: false, code: 'insufficient_balance', balance: 2 }, error: null }),
    })
    const r = await reserveAiCost({ supabase: c, userId: 'u1', ability: 'generation', refId: 'g1' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('insufficient_balance')
      expect(r.required).toBe(10)
    }
  })
})

describe('settleAiCost：调用后按真实用量结算', () => {
  it('实际 > 预扣 → 补扣差额', async () => {
    const c = fakeClient({
      select: async (t) =>
        t === 'point_config'
          ? { data: [{ key: 'POINTS_PER_YUAN', value: 20 }], error: null }
          : { data: { balance: 26 }, error: null },
      rpc: async (_fn, args) => {
        return { data: { ok: true, balance: 26, refunded: args.p_amount ?? 0 }, error: null }
      },
    })
    const r = await settleAiCost({
      supabase: c,
      userId: 'u1',
      refId: 'g1',
      reserved: 10,
      usage: { cachedTokens: 0, missTokens: 0, outputTokens: 200_000 },
    })
    // 200k 输出 token = 1.2 元 × 20 = 24.000000000000004 → 向上取整 25。
    // 这个浮点尾巴是刻意的：抹零等于允许无限次"几乎免费"的生成。
    expect(r.actual).toBe(25)
    expect(r.extraCharged).toBe(15)
    expect(r.refunded).toBe(0)
  })

  it('★实际 < 预扣 → 差额退回（预扣不是涨价）', async () => {
    let refundRef = ''
    const c = fakeClient({
      select: async (t) =>
        t === 'point_config'
          ? { data: [{ key: 'POINTS_PER_YUAN', value: 20 }], error: null }
          : { data: { balance: 41 }, error: null },
      rpc: async (fn, args) => {
        if (fn === 'refund_points') {
          refundRef = String(args.p_reference_id ?? '')
          return { data: { ok: true, balance: 41, refunded: args.p_amount }, error: null }
        }
        return { data: { ok: true, balance: 41 }, error: null }
      },
    })
    const r = await settleAiCost({
      supabase: c,
      userId: 'u1',
      refId: 'g1',
      reserved: 10,
      // 零用量 → 按保底 1 积分计 → 应退 9
      usage: { cachedTokens: 0, missTokens: 0, outputTokens: 0 },
    })
    expect(r.actual).toBe(1)
    expect(r.refunded).toBe(9)
    expect(r.extraCharged).toBe(0)
    expect(refundRef).toBe('g1:refund')
  })

  it('实际 = 预扣 → 不补扣也不退款', async () => {
    let rpcCalled = 0
    const c = fakeClient({
      select: async (t) =>
        t === 'point_config'
          ? { data: [{ key: 'POINTS_PER_YUAN', value: 20 }], error: null }
          : { data: { balance: 30 }, error: null },
      rpc: async () => {
        rpcCalled += 1
        return { data: { ok: true, balance: 30 }, error: null }
      },
    })
    // 零用量 → 按保底 1 积分计；预扣也是 1 → 既无需补扣也无需退款
    const r = await settleAiCost({
      supabase: c,
      userId: 'u1',
      refId: 'g1',
      reserved: 1,
      usage: { cachedTokens: 0, missTokens: 0, outputTokens: 0 },
    })
    expect(r.actual).toBe(1)
    expect(r.extraCharged).toBe(0)
    expect(r.refunded).toBe(0)
    expect(rpcCalled).toBe(0)
  })

  it('结算失败不抛错（作品已生成，记账失败不能让作品消失）', async () => {
    const c = fakeClient({
      select: async (t) =>
        t === 'point_config'
          ? { data: [{ key: 'POINTS_PER_YUAN', value: 20 }], error: null }
          : { data: null, error: { message: 'boom' } },
      rpc: async () => ({ data: null, error: { message: 'boom' } }),
    })
    await expect(
      settleAiCost({
        supabase: c,
        userId: 'u1',
        refId: 'g1',
        reserved: 10,
        usage: { cachedTokens: 0, missTokens: 0, outputTokens: 200_000 },
      })
    ).resolves.toMatchObject({ actual: 25, extraCharged: 0 })
  })
})

describe('refundAiCost：调用失败全额退', () => {
  it('退回全部预扣', async () => {
    let captured: Record<string, unknown> = {}
    const c = fakeClient({
      rpc: async (_fn, args) => {
        captured = args
        return { data: { ok: true, balance: 50, refunded: 10 }, error: null }
      },
    })
    const r = await refundAiCost({ supabase: c, userId: 'u1', refId: 'g1', amount: 10 })
    expect(r.ok).toBe(true)
    expect(r.refunded).toBe(10)
    expect(captured.p_reference_id).toBe('g1:failed')
    expect(captured.p_amount).toBe(10)
  })

  it('退 0 不发起 RPC', async () => {
    let called = 0
    const c = fakeClient({
      rpc: async () => {
        called += 1
        return { data: { ok: true }, error: null }
      },
    })
    await expect(refundAiCost({ supabase: c, userId: 'u1', refId: 'g1', amount: 0 })).resolves.toEqual({
      ok: true,
      refunded: 0,
    })
    expect(called).toBe(0)
  })
})
