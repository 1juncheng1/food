// ============================================================
// lib/adminPoints —— 管理端积分操作（Phase 3）
//
// 这里锁的是"唯一能凭空产生积分的入口"的契约：
//   · 确认到账按**实际到账金额**算积分，重复确认必须体现为 duplicated
//   · 拒绝订单一分不加
//   · 手动调整必须带原因，且返回可追溯的调整单号
//   · 保存收款配置不能把没传的字段清成 null
// ============================================================

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adjustPoints,
  confirmRecharge,
  makeAdjustmentRef,
  rejectRecharge,
  updatePaymentSettings,
} from './adminPoints'

function fakeClient(impl: {
  rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
  upsert?: (table: string, payload: Record<string, unknown>) => Promise<{ error: unknown }>
}): SupabaseClient {
  return {
    from: (table: string) => ({
      upsert: (payload: Record<string, unknown>) =>
        impl.upsert?.(table, payload) ?? Promise.resolve({ error: null }),
      select: () => ({
        order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
      }),
    }),
    rpc: (fn: string, args: Record<string, unknown>) =>
      impl.rpc?.(fn, args) ?? Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient
}

describe('confirmRecharge：确认到账', () => {
  it('按实际到账金额算出积分（10 元 × 20 = 200）', async () => {
    const c = fakeClient({
      rpc: async () => ({
        data: { ok: true, duplicated: false, points: 200, balance: 220, confirmedAmount: 10 },
        error: null,
      }),
    })
    const r = await confirmRecharge(c, 'o1', 10, 'admin1', '已核对')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.points).toBe(200)
      expect(r.confirmedAmount).toBe(10)
      expect(r.duplicated).toBe(false)
    }
  })

  it('多付的场景：申请 10 元、实际到账 20 元 → 400 积分', async () => {
    const c = fakeClient({
      rpc: async () => ({
        data: { ok: true, duplicated: false, points: 400, balance: 420, confirmedAmount: 20 },
        error: null,
      }),
    })
    const r = await confirmRecharge(c, 'o1', 20, 'admin1')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.points).toBe(400)
  })

  it('★重复确认：duplicated=true，不再产生积分', async () => {
    const c = fakeClient({
      rpc: async () => ({
        data: { ok: true, duplicated: true, points: 200, balance: 220 },
        error: null,
      }),
    })
    const r = await confirmRecharge(c, 'o1', 10, 'admin1')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.duplicated).toBe(true)
  })

  it('订单不存在 → 中文提示，不抛异常', async () => {
    const c = fakeClient({ rpc: async () => ({ data: { ok: false, code: 'not_found' }, error: null }) })
    const r = await confirmRecharge(c, 'o1', 10, 'admin1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('订单不存在')
  })

  it('已取消/已拒绝的订单不能确认', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: false, code: 'already_closed' }, error: null }),
    })
    const r = await confirmRecharge(c, 'o1', 10, 'admin1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('已关闭')
  })

  it('金额为 0 或负数 → 请填写正确金额', async () => {
    const c = fakeClient({ rpc: async () => ({ data: { ok: false, code: 'bad_amount' }, error: null }) })
    const r = await confirmRecharge(c, 'o1', 0, 'admin1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('实际到账金额')
  })

  it('非服务端通道 → forbidden 文案', async () => {
    const c = fakeClient({ rpc: async () => ({ data: { ok: false, code: 'forbidden' }, error: null }) })
    const r = await confirmRecharge(c, 'o1', 10, 'admin1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('无权')
  })

  it('RPC 报错 → 不抛异常', async () => {
    const c = fakeClient({ rpc: async () => ({ data: null, error: { message: 'boom' } }) })
    await expect(confirmRecharge(c, 'o1', 10, 'admin1')).resolves.toMatchObject({ ok: false })
  })
})

describe('rejectRecharge：拒绝（一分不加）', () => {
  it('成功', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: true, duplicated: false, status: 'REJECTED' }, error: null }),
    })
    await expect(rejectRecharge(c, 'o1', 'admin1', '未收到')).resolves.toEqual({
      ok: true,
      duplicated: false,
    })
  })

  it('已确认的订单不能拒绝', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: false, code: 'already_closed' }, error: null }),
    })
    const r = await rejectRecharge(c, 'o1', 'admin1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('已确认')
  })
})

describe('adjustPoints：手动调整', () => {
  it('成功返回余额与调整单号（可追溯）', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: true, balance: 120, duplicated: false }, error: null }),
    })
    const r = await adjustPoints(c, { userId: 'u1', delta: 100, reason: '补偿用户', adminId: 'admin1' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.balance).toBe(120)
      expect(r.referenceId).toMatch(/^ADJ-/)
    }
  })

  it('扣减导致负余额 → 明确拒绝', async () => {
    const c = fakeClient({
      rpc: async () => ({ data: { ok: false, code: 'insufficient_balance' }, error: null }),
    })
    const r = await adjustPoints(c, { userId: 'u1', delta: -500, reason: '测试', adminId: 'admin1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('负数')
  })

  it('缺原因 → 提示填写（SQL 层也会挡，这里只是把错误翻成人话）', async () => {
    const c = fakeClient({ rpc: async () => ({ data: { ok: false, code: 'bad_params' }, error: null }) })
    const r = await adjustPoints(c, { userId: 'u1', delta: 10, reason: '', adminId: 'admin1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('原因')
  })

  it('调整单号每次都不同（幂等键不能撞车）', () => {
    const a = makeAdjustmentRef()
    const b = makeAdjustmentRef()
    expect(a).not.toBe(b)
  })
})

describe('updatePaymentSettings：收款码配置', () => {
  it('只更新传入的字段，不把其它字段清成 null', async () => {
    let captured: Record<string, unknown> = {}
    const c = fakeClient({
      upsert: async (_t, payload) => {
        captured = payload
        return { error: null }
      },
    })
    const r = await updatePaymentSettings(c, { qrImageUrl: 'https://x/qr.png' }, 'admin1')
    expect(r.ok).toBe(true)
    expect(captured.qr_image_url).toBe('https://x/qr.png')
    expect(captured.method).toBeUndefined()
    expect(captured.instruction).toBeUndefined()
  })

  it('失败 → 中文提示', async () => {
    const c = fakeClient({ upsert: async () => ({ error: { message: 'denied' } }) })
    await expect(updatePaymentSettings(c, { method: '支付宝' }, 'admin1')).resolves.toMatchObject({
      ok: false,
    })
  })
})
