// ============================================================
// lib/recharge —— 充值链路契约（Phase 2）
//
// 这里锁住人工收款模式最容易写错的三条：
//   ① 「预计积分」只是展示值，不能在任何地方被当成入账依据
//   ② 「我已付款」只改状态，绝不能顺手加积分
//   ③ 金额门槛由服务端按配置校验，不是前端说多少就是多少
// ============================================================

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  FALLBACK_QUICK_AMOUNTS,
  cancelOrder,
  createRechargeOrder,
  estimatePoints,
  fetchRechargeConfig,
  markOrderPaid,
  normalizeOrder,
  parseQuickAmounts,
  validateAmount,
} from './recharge'

function fakeClient(impl: {
  select?: (table: string) => Promise<{ data: unknown; error: unknown }>
  maybeSingle?: (table: string) => Promise<{ data: unknown; error: unknown }>
  rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
}): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => {
        const direct = impl.select?.(table) ?? Promise.resolve({ data: null, error: null })
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

const CFG = { min: 5, max: 5000 }

describe('estimatePoints：预计积分（仅展示）', () => {
  it('10 元 → 200 积分（1 元 = 20 积分）', () => {
    expect(estimatePoints(10, 20)).toBe(200)
  })

  it('需求档位：5/20/50/100 元', () => {
    expect(estimatePoints(5, 20)).toBe(100)
    expect(estimatePoints(20, 20)).toBe(400)
    expect(estimatePoints(50, 20)).toBe(1000)
    expect(estimatePoints(100, 20)).toBe(2000)
  })
})

describe('validateAmount：金额门槛校验', () => {
  it('合法金额通过', () => {
    expect(validateAmount(10, CFG)).toBeNull()
  })

  it('低于最低充值金额（5 元）→ below_min', () => {
    expect(validateAmount(1, CFG)).toMatchObject({ code: 'below_min' })
  })

  it('超过单笔上限 → above_max', () => {
    expect(validateAmount(99999, CFG)).toMatchObject({ code: 'above_max' })
  })

  it('0 / 负数 / 非数字 → bad_amount', () => {
    expect(validateAmount(0, CFG)).toMatchObject({ code: 'bad_amount' })
    expect(validateAmount(-10, CFG)).toMatchObject({ code: 'bad_amount' })
    expect(validateAmount('abc', CFG)).toMatchObject({ code: 'bad_amount' })
  })
})

describe('normalizeOrder：行 → 订单', () => {
  it('正常行（numeric 字符串也能解析）', () => {
    const o = normalizeOrder({
      id: 'o1',
      order_no: 'RC240924ABC12345',
      user_id: 'u1',
      requested_amount: '10',
      confirmed_amount: '20',
      points: '400',
      status: 'CONFIRMED',
      created_at: '2026-09-24T00:00:00Z',
    })
    expect(o).toMatchObject({
      orderNo: 'RC240924ABC12345',
      requestedAmount: 10,
      confirmedAmount: 20,
      points: 400,
      status: 'CONFIRMED',
    })
  })

  it('未确认订单的 confirmedAmount / points 为 null（不是 0）', () => {
    const o = normalizeOrder({
      id: 'o1',
      order_no: 'RC1',
      user_id: 'u1',
      requested_amount: 10,
      status: 'PENDING',
    })
    expect(o?.confirmedAmount).toBeNull()
    expect(o?.points).toBeNull()
  })

  it('非法状态 / 缺字段 → null', () => {
    expect(normalizeOrder({ id: 'o1', order_no: 'RC1', user_id: 'u1', requested_amount: 10, status: 'WHATEVER' })).toBeNull()
    expect(normalizeOrder({})).toBeNull()
  })
})

describe('createRechargeOrder：创建订单', () => {
  it('成功：返回订单', async () => {
    const c = fakeClient({
      rpc: async () => ({
        data: {
          ok: true,
          order: {
            id: 'o1',
            order_no: 'RC1',
            user_id: 'u1',
            requested_amount: 10,
            status: 'PENDING',
            created_at: '2026-09-24T00:00:00Z',
          },
        },
        error: null,
      }),
    })
    const r = await createRechargeOrder(c, 10)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.order.status).toBe('PENDING')
  })

  it('低于下限：把数据库的 min 翻成人话', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: false, code: 'below_min', min: 5 }, error: null }),
    })
    const r = await createRechargeOrder(c, 1)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('below_min')
      expect(r.message).toContain('5')
    }
  })

  it('超过上限', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: false, code: 'above_max', max: 5000 }, error: null }),
    })
    const r = await createRechargeOrder(c, 99999)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('5000')
  })

  it('RPC 报错 → 中文兜底文案，不抛异常', async () => {
    const c = fakeClient({ rpc: async () => ({ data: null, error: { message: 'boom' } }) })
    await expect(createRechargeOrder(c, 10)).resolves.toMatchObject({ ok: false, code: 'error' })
  })
})

describe('markOrderPaid：我已付款（只改状态）', () => {
  it('PENDING → PAID，changed=true', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: true, status: 'PAID', changed: true }, error: null }),
    })
    await expect(markOrderPaid(c, 'o1')).resolves.toEqual({
      ok: true,
      status: 'PAID',
      changed: true,
    })
  })

  it('重复点击：幂等返回当前状态，changed=false，不报错', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: true, status: 'PAID', changed: false }, error: null }),
    })
    await expect(markOrderPaid(c, 'o1')).resolves.toMatchObject({ ok: true, changed: false })
  })

  it('订单不存在 → 中文提示', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: false, code: 'not_found' }, error: null }),
    })
    await expect(markOrderPaid(c, 'o1')).resolves.toMatchObject({ ok: false })
  })
})

describe('cancelOrder：用户取消', () => {
  it('成功', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: true, status: 'CANCELLED' }, error: null }),
    })
    await expect(cancelOrder(c, 'o1')).resolves.toEqual({ ok: true, status: 'CANCELLED' })
  })

  it('已确认的订单不能取消', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: false, code: 'already_closed', status: 'CONFIRMED' }, error: null }),
    })
    const r = await cancelOrder(c, 'o1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('已确认')
  })
})

describe('fetchRechargeConfig：收款码与价格口径', () => {
  it('读到收款码与汇率', async () => {
    const c = fakeClient({
      select: async (t) =>
        t === 'point_config'
          ? { data: [{ key: 'POINTS_PER_YUAN', value: 20 }], error: null }
          : { data: null, error: null },
      maybeSingle: async () => ({
        data: {
          method: '微信',
          qr_image_url: 'https://example.com/qr.png',
          instruction: '扫码付款',
        },
        error: null,
      }),
    })
    const cfg = await fetchRechargeConfig(c)
    expect(cfg.pointsPerYuan).toBe(20)
    expect(cfg.payment.qrImageUrl).toBe('https://example.com/qr.png')
  })

  it('未配置二维码 → qrImageUrl 为 null（前端据此提示联系管理员，不展示空白图）', async () => {
    const c = fakeClient({
      maybeSingle: async () => ({ data: null, error: null }),
    })
    const cfg = await fetchRechargeConfig(c)
    expect(cfg.payment.qrImageUrl).toBeNull()
    expect(cfg.payment.instruction).toBeTruthy()
  })

  it('下发快捷档位与支付通道（需求 §4：充值规则不许写死在前端）', async () => {
    // fetchRechargeConfig 对 payment_settings 查两次（收款码 / 快捷档位），
    // 这里按调用序号分别返回
    let call = 0
    const c = fakeClient({
      maybeSingle: async () => {
        call += 1
        return call === 1
          ? { data: { method: '微信', qr_image_url: 'https://example.com/qr.png' }, error: null }
          : { data: { quick_amounts: [10, 50] }, error: null }
      },
    })
    const cfg = await fetchRechargeConfig(c)
    expect(cfg.quickAmounts).toEqual([10, 50])
    expect(cfg.provider).toMatchObject({ id: 'MANUAL', autoConfirm: false })
  })

  it('迁移 0020 未执行（quick_amounts 列不存在）→ 回落默认档位，收款码照常可用', async () => {
    let call = 0
    const c = fakeClient({
      maybeSingle: async () => {
        call += 1
        return call === 1
          ? { data: { method: '微信', qr_image_url: 'https://example.com/qr.png' }, error: null }
          : {
              data: null,
              error: { code: '42703', message: 'column payment_settings.quick_amounts does not exist' },
            }
      },
    })
    const cfg = await fetchRechargeConfig(c)
    expect(cfg.quickAmounts).toEqual(FALLBACK_QUICK_AMOUNTS)
    expect(cfg.payment.qrImageUrl).toBe('https://example.com/qr.png')
  })
})

describe('parseQuickAmounts：快捷档位解析', () => {
  it('PostgREST 直接给数组', () => {
    expect(parseQuickAmounts([5, 10, 20, 50, 100])).toEqual([5, 10, 20, 50, 100])
  })

  it('numeric[] 以字符串形式返回（{5,10,20}）', () => {
    expect(parseQuickAmounts('{5,10,20}')).toEqual([5, 10, 20])
  })

  it('脏数据剔除：0 / 负数 / 非数字 / 重复值', () => {
    expect(parseQuickAmounts([10, 0, -5, 'abc', 10, 20])).toEqual([10, 20])
  })

  it('null / undefined / 空串 → 空数组（调用方回落默认档位）', () => {
    expect(parseQuickAmounts(null)).toEqual([])
    expect(parseQuickAmounts(undefined)).toEqual([])
    expect(parseQuickAmounts('')).toEqual([])
  })

  it('乱序输入按金额升序输出', () => {
    expect(parseQuickAmounts([100, 5, 20])).toEqual([5, 20, 100])
  })
})

describe('normalizeOrder：支付通道回落（需求 §18）', () => {
  it('provider 缺失 → MANUAL', () => {
    const o = normalizeOrder({
      id: 'o1',
      order_no: 'RC1',
      user_id: 'u1',
      requested_amount: 10,
      status: 'PENDING',
    })
    expect(o?.provider).toBe('MANUAL')
  })

  it('provider 是未知值 → MANUAL（保守方向：宁可人工确认，也不自动加积分）', () => {
    const o = normalizeOrder({
      id: 'o1',
      order_no: 'RC1',
      user_id: 'u1',
      requested_amount: 10,
      status: 'PENDING',
      provider: 'SOME_FUTURE_PROVIDER',
    })
    expect(o?.provider).toBe('MANUAL')
  })
})
