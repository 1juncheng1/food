'use client'

// ────────────────────────────────────────────────────────────
// 积分充值 /recharge
//
// 人工收款模式：不接任何第三方支付。流程刻意做得朴素——
//   填金额 → 生成订单 → 扫收款码付款 → 点「我已付款」→ 等管理员确认 → 积分到账
//
// 页面最重要的诚实点：
//   1. 「预计获得」只是按汇率算的展示值，**实际到账积分以管理员核实的金额为准**；
//   2. 点「我已付款」不会立刻加积分，只是把订单推进到「待确认」；
//   3. 不做支付动画、不假装"已检测到付款"。
// ────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react'
import {
  CheckCircle2,
  Clock,
  Loader2,
  QrCode,
  ShieldAlert,
  Wallet,
  XCircle,
} from 'lucide-react'
import { getValidSession } from '@/lib/supabaseClient'
import {
  ORDER_STATUS_TEXT,
  type OrderStatus,
  type RechargeConfig,
  type RechargeOrder,
} from '@/lib/recharge'
import {
  EmptyState,
  ErrorState,
  PageHeader,
  PageShell,
  Section,
  StatRow,
  SurfaceCard,
} from '@/components/vision'

/** 快捷金额档位：覆盖绝大多数充值场景，同时保留自定义输入 */
const QUICK_AMOUNTS = [5, 10, 20, 50, 100] as const

export default function RechargePage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [config, setConfig] = useState<RechargeConfig | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [orders, setOrders] = useState<RechargeOrder[]>([])

  const [amount, setAmount] = useState<string>('10')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  /** 当前正在跟进的订单：有值时页面切换到"收款码 + 状态跟进"视图 */
  const [current, setCurrent] = useState<RechargeOrder | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  /** 带 token 的请求封装：统一处理 401/503，避免各调用点各写一套 */
  async function api<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
    const session = await getValidSession()
    if (!session) return { ok: false, message: '登录已过期，请重新登录' }
    const res = await fetch(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    }).catch(() => null)
    if (!res) return { ok: false, message: '网络异常，请稍后重试' }
    const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null
    if (!res.ok) {
      // 503 = 网络故障，不得当成未登录把用户踢走（见 lib/apiAuth.ts）
      return { ok: false, message: json?.error ?? '操作失败，请稍后重试' }
    }
    return { ok: true, data: json as T }
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [cfgRes, balRes, orderRes] = await Promise.all([
      api<RechargeConfig>('/api/recharge/config'),
      api<{ balance: number | null }>('/api/user/balance'),
      api<{ orders: RechargeOrder[] }>('/api/recharge/orders'),
    ])
    if (cfgRes.ok) setConfig(cfgRes.data)
    if (balRes.ok && typeof balRes.data.balance === 'number') setBalance(balRes.data.balance)
    if (orderRes.ok) setOrders(orderRes.data.orders ?? [])
    if (!cfgRes.ok && !balRes.ok && !orderRes.ok) {
      setError(cfgRes.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const amountNumber = Number(amount)
  const pointsPerYuan = config?.pointsPerYuan ?? 20
  const minAmount = config?.minAmount ?? 5
  const maxAmount = config?.maxAmount ?? 5000
  const validAmount =
    Number.isFinite(amountNumber) && amountNumber >= minAmount && amountNumber <= maxAmount
  /** 预计积分（仅展示）：真正的入账积分由服务端按实际到账金额计算 */
  const estimated = validAmount ? Math.floor(amountNumber * pointsPerYuan) : 0

  async function submitOrder() {
    if (!validAmount || submitting) return
    setSubmitting(true)
    setActionError(null)
    const res = await api<{ order: RechargeOrder }>('/api/recharge/orders', {
      method: 'POST',
      body: JSON.stringify({ amount: amountNumber, note: note.trim() || undefined }),
    })
    setSubmitting(false)
    if (!res.ok) {
      setActionError(res.message)
      return
    }
    setCurrent(res.data.order)
    setOrders((prev) => [res.data.order, ...prev])
  }

  async function markPaid() {
    if (!current) return
    setSubmitting(true)
    setActionError(null)
    const res = await api<{ status: OrderStatus }>(`/api/recharge/orders/${current.id}/pay`, {
      method: 'POST',
    })
    setSubmitting(false)
    if (!res.ok) {
      setActionError(res.message)
      return
    }
    const status = res.data.status
    setCurrent({ ...current, status })
    setOrders((prev) => prev.map((o) => (o.id === current.id ? { ...o, status } : o)))
  }

  async function cancelOrder() {
    if (!current) return
    setSubmitting(true)
    setActionError(null)
    const res = await api<{ status: OrderStatus }>(`/api/recharge/orders/${current.id}/cancel`, {
      method: 'POST',
    })
    setSubmitting(false)
    if (!res.ok) {
      setActionError(res.message)
      return
    }
    const status = res.data.status
    setOrders((prev) => prev.map((o) => (o.id === current.id ? { ...o, status } : o)))
    setCurrent(null)
  }

  if (loading) {
    return (
      <PageShell width="narrow">
        <div className="flex items-center justify-center gap-2 py-24 text-sm text-zinc-500">
          <Loader2 size={16} className="animate-spin" />
          正在加载账户信息…
        </div>
      </PageShell>
    )
  }

  if (error) {
    return (
      <PageShell width="narrow">
        <ErrorState title="无法加载充值信息" message={error} onRetry={load} />
      </PageShell>
    )
  }

  return (
    <PageShell width="narrow">
      <PageHeader
        eyebrow="账户"
        title="积分充值"
        description="积分用于支付 AI 创作能力。付款后由管理员人工核账确认，确认到账后积分立即入账。"
      />

      {/* ── 当前余额 ── */}
      <StatRow
        items={[
          { label: '当前积分', value: balance ?? '—', hint: balance === null ? '未获取到' : undefined },
          { label: '汇率', value: `1 元 = ${pointsPerYuan} 积分` },
        ]}
        className="grid-cols-2 sm:grid-cols-2"
      />

      <div className="h-8" />

      {/* ── 有正在跟进的订单：展示收款码与状态 ── */}
      {current ? (
        <SurfaceCard tone="raised">
          <div className="flex items-center gap-2">
            {current.status === 'PENDING' && <QrCode size={16} className="text-indigo-300" />}
            {current.status === 'PAID' && <Clock size={16} className="text-amber-300" />}
            {current.status === 'CONFIRMED' && <CheckCircle2 size={16} className="text-emerald-300" />}
            {(current.status === 'REJECTED' || current.status === 'CANCELLED') && (
              <XCircle size={16} className="text-zinc-400" />
            )}
            <span className="text-sm font-medium text-zinc-200">
              {current.status === 'PENDING' && '请使用收款码付款'}
              {current.status === 'PAID' && '已收到你的付款声明，等待管理员确认'}
              {current.status === 'CONFIRMED' && '已确认到账，积分已入账'}
              {current.status === 'REJECTED' && '管理员未收到该笔款项'}
              {current.status === 'CANCELLED' && '订单已取消'}
            </span>
          </div>

          {current.status === 'PENDING' && (
            <div className="mt-5 flex flex-col items-center">
              {config?.payment.qrImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={config.payment.qrImageUrl}
                  alt={`${config.payment.method}收款码`}
                  className="h-[240px] w-[240px] rounded-xl border border-white/[0.1] bg-white object-contain"
                />
              ) : (
                <div className="flex h-[240px] w-[240px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/[0.12] bg-white/[0.02] px-6 text-center">
                  <ShieldAlert size={22} className="text-amber-300" />
                  <p className="text-[13px] text-zinc-400">
                    管理员尚未配置收款码，请联系管理员后再付款
                  </p>
                </div>
              )}
              {config?.payment.instruction && (
                <p className="mt-4 max-w-md text-center text-[13px] leading-relaxed text-zinc-400">
                  {config.payment.instruction}
                </p>
              )}
            </div>
          )}

          <div className="vs-divider my-5" />

          <div className="space-y-2 text-[13px]">
            <Row label="订单号" value={current.orderNo} />
            <Row label="充值金额" value={`${current.requestedAmount} 元`} />
            <Row
              label={current.status === 'CONFIRMED' ? '实际到账积分' : '预计到账积分'}
              value={
                current.status === 'CONFIRMED' && current.points !== null
                  ? `${current.points} 积分`
                  : `${Math.floor(current.requestedAmount * pointsPerYuan)} 积分`
              }
            />
            {current.status === 'CONFIRMED' && current.confirmedAmount !== null && (
              <Row label="实际到账金额" value={`${current.confirmedAmount} 元`} />
            )}
            <Row label="状态" value={ORDER_STATUS_TEXT[current.status]} />
            {current.adminNote && <Row label="管理员备注" value={current.adminNote} />}
          </div>

          {current.status === 'CONFIRMED' && (
            <p className="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-[13px] text-emerald-200">
              积分已入账，最终积分以管理员核实的实际到账金额计算。
            </p>
          )}
          {current.status === 'REJECTED' && (
            <p className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">
              管理员未收到该笔款项，积分未增加。如已付款请联系管理员核对。
            </p>
          )}

          {actionError && (
            <p className="mt-4 text-[13px] text-red-300">{actionError}</p>
          )}

          <div className="mt-5 flex flex-wrap gap-2.5">
            {current.status === 'PENDING' && (
              <>
                <button
                  onClick={markPaid}
                  disabled={submitting}
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
                >
                  {submitting && <Loader2 size={14} className="animate-spin" />}
                  我已付款
                </button>
                <button
                  onClick={cancelOrder}
                  disabled={submitting}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/[0.1] px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-white/20 hover:text-white disabled:opacity-50"
                >
                  取消订单
                </button>
              </>
            )}
            {(current.status === 'PAID' ||
              current.status === 'CONFIRMED' ||
              current.status === 'REJECTED' ||
              current.status === 'CANCELLED') && (
              <button
                onClick={() => setCurrent(null)}
                className="inline-flex items-center gap-2 rounded-xl border border-white/[0.1] px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-white/20 hover:text-white"
              >
                {current.status === 'PAID' ? '返回（可稍后查看状态）' : '完成'}
              </button>
            )}
          </div>
        </SurfaceCard>
      ) : (
        /* ── 无跟进订单：展示充值表单 ── */
        <SurfaceCard tone="raised">
          <p className="text-sm font-medium text-zinc-200">选择充值金额</p>

          <div className="mt-4 flex flex-wrap gap-2">
            {QUICK_AMOUNTS.map((v) => (
              <button
                key={v}
                onClick={() => setAmount(String(v))}
                className={`rounded-xl border px-4 py-2 text-sm transition ${
                  Number(amount) === v
                    ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-200'
                    : 'border-white/[0.1] text-zinc-300 hover:border-white/20 hover:text-white'
                }`}
              >
                {v} 元
              </button>
            ))}
          </div>

          <div className="mt-5 flex items-center gap-3">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              type="number"
              min={minAmount}
              max={maxAmount}
              step={1}
              aria-label="充值金额（元）"
              className="w-40 rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 outline-none transition focus:border-indigo-500/40"
            />
            <span className="text-sm text-zinc-500">元</span>
            <span className="ml-auto text-sm text-zinc-300">
              预计获得 <span className="font-semibold text-white">{estimated}</span> 积分
            </span>
          </div>

          <p className="mt-2 text-[12px] leading-relaxed text-zinc-500">
            最低 {minAmount} 元，单笔上限 {maxAmount} 元。预计积分为展示值，
            最终以管理员核实的实际到账金额计算。
          </p>

          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="备注（可选，例如付款账号后四位，便于管理员核对）"
            aria-label="充值备注"
            className="mt-4 w-full rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-indigo-500/40"
          />

          {actionError && <p className="mt-3 text-[13px] text-red-300">{actionError}</p>}

          <button
            onClick={submitOrder}
            disabled={!validAmount || submitting}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            <Wallet size={15} />
            生成充值订单
          </button>
        </SurfaceCard>
      )}

      <div className="h-10" />

      {/* ── 我的充值订单 ── */}
      <Section title="我的充值订单">
        {orders.length === 0 ? (
          <EmptyState
            compact
            icon={<Wallet size={18} />}
            title="还没有充值记录"
            description="创建订单后，这里会保留每一笔充值与到账状态。"
          />
        ) : (
          <div className="space-y-2.5">
            {orders.map((o) => (
              <div
                key={o.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-white/[0.07] bg-white/[0.025] px-4 py-3"
              >
                <span className="font-mono text-[12px] text-zinc-500">{o.orderNo}</span>
                <span className="text-[13px] text-zinc-300">{o.requestedAmount} 元</span>
                <span className="text-[13px] text-zinc-500">
                  {o.points !== null ? `${o.points} 积分` : `≈ ${Math.floor(o.requestedAmount * pointsPerYuan)} 积分`}
                </span>
                <span className="ml-auto text-[12px] text-zinc-400">
                  {ORDER_STATUS_TEXT[o.status]}
                </span>
                <button
                  onClick={() => setCurrent(o)}
                  className="text-[12px] text-indigo-300 transition hover:text-indigo-200"
                >
                  查看
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>
    </PageShell>
  )
}

/** 键值行：订单详情里反复用到，抽出来避免每处都手写一遍排版 */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className="text-right text-zinc-200">{value}</span>
    </div>
  )
}
