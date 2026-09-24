// ============================================================
// PUT /api/admin/settings —— 收款码配置 + 积分价格配置
//
// body:
//   { payment?: { method?, qrImageUrl?, accountName?, instruction? } }
//   { config?: { key, value } }   // 例如把 POINTS_PER_YUAN 从 20 调成 15
//
// 为什么价格要能在这里改：需求 §21 明确要求「不要修改代码才能调整价格」。
// 运营改完这条配置，下一次充值与下一次 AI 扣费立刻按新汇率走
// （配置有 60 秒进程内缓存，最迟一分钟内生效）。
// ============================================================

import { NextResponse } from 'next/server'
import { requireAdmin, requireServiceClient } from '@/lib/adminAuth'
import { updatePaymentSettings, updatePointConfig } from '@/lib/adminPoints'
import { CONFIG_KEYS } from '@/lib/points'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

/** 允许后台改的配置键（不是所有键都该被 UI 暴露） */
const EDITABLE_KEYS = new Set<string>([
  CONFIG_KEYS.POINTS_PER_YUAN,
  CONFIG_KEYS.MIN_RECHARGE_AMOUNT,
  CONFIG_KEYS.MAX_RECHARGE_AMOUNT,
  CONFIG_KEYS.REGISTER_BONUS_POINTS,
  CONFIG_KEYS.MIN_GENERATION_COST,
  CONFIG_KEYS.AI_PRECHARGE_GENERATION,
  CONFIG_KEYS.AI_PRECHARGE_BLUEPRINT,
  CONFIG_KEYS.AI_PRECHARGE_DIAGNOSIS,
  CONFIG_KEYS.AI_PRECHARGE_CHAT,
])

/** 二维码地址只接受 http(s)：挡掉 javascript: / data: 这类可被利用的协议 */
function isSafeUrl(v: unknown): v is string {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim())
}

export async function PUT(req: Request) {
  const admin = await requireAdmin(req)
  if (!admin.ok) return admin.response

  const svc = await requireServiceClient()
  if (!svc.ok) return svc.response

  let body: {
    payment?: { method?: unknown; qrImageUrl?: unknown; accountName?: unknown; instruction?: unknown }
    config?: { key?: unknown; value?: unknown }
  }
  try {
    body = (await req.json()) ?? {}
  } catch {
    return NextResponse.json({ error: '请求格式有误' }, { status: 400, headers: NO_STORE })
  }

  // ── 收款码配置 ──
  if (body.payment) {
    const p = body.payment
    const patch: Parameters<typeof updatePaymentSettings>[1] = {}

    if (p.method !== undefined) {
      if (typeof p.method !== 'string' || !p.method.trim() || p.method.length > 40) {
        return NextResponse.json({ error: '收款方式不合法' }, { status: 400, headers: NO_STORE })
      }
      patch.method = p.method.trim()
    }
    if (p.qrImageUrl !== undefined) {
      if (p.qrImageUrl === null || p.qrImageUrl === '') {
        patch.qrImageUrl = null
      } else if (!isSafeUrl(p.qrImageUrl)) {
        return NextResponse.json(
          { error: '二维码地址必须是 http(s) 链接' },
          { status: 400, headers: NO_STORE }
        )
      } else {
        patch.qrImageUrl = p.qrImageUrl.trim()
      }
    }
    if (p.accountName !== undefined) {
      patch.accountName = typeof p.accountName === 'string' && p.accountName.trim() ? p.accountName.trim().slice(0, 60) : null
    }
    if (p.instruction !== undefined) {
      patch.instruction = typeof p.instruction === 'string' && p.instruction.trim() ? p.instruction.trim().slice(0, 300) : null
    }

    const r = await updatePaymentSettings(svc.db, patch, admin.auth.userId)
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: 500, headers: NO_STORE })
  }

  // ── 价格配置 ──
  if (body.config) {
    const key = typeof body.config.key === 'string' ? body.config.key : ''
    const value = typeof body.config.value === 'number' ? body.config.value : Number(body.config.value)
    if (!EDITABLE_KEYS.has(key)) {
      return NextResponse.json({ error: '该配置项不允许修改' }, { status: 400, headers: NO_STORE })
    }
    if (!Number.isFinite(value) || value < 0) {
      return NextResponse.json({ error: '配置值必须是非负数字' }, { status: 400, headers: NO_STORE })
    }
    // 汇率不能是 0：那会让所有充值算出 0 积分，等于全站免单
    if (key === CONFIG_KEYS.POINTS_PER_YUAN && value <= 0) {
      return NextResponse.json({ error: '汇率必须大于 0' }, { status: 400, headers: NO_STORE })
    }
    const r = await updatePointConfig(svc.db, key, value, admin.auth.userId)
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: 500, headers: NO_STORE })
  }

  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
