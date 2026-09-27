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
  Wallet,
  XCircle,
} from 'lucide-react'
import { getValidSession } from '@/lib/supabaseClient'
import { getPaymentProvider } from '@/lib/paymentProvider'
import {
  FALLBACK_QUICK_AMOUNTS,
  ORDER_STATUS_TEXT,
  estimatePoints,
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

/**
 * 待确认订单的自动刷新间隔。
 * 需求 §19：用户点完「我已完成支付」就该等着，不该被要求手动刷新页面。
 * 15 秒一次足够快（管理员确认后最多 15 秒到账），又不至于把接口打满。
 */
const POLL_INTERVAL_MS = 15_000

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
    if (orderRes.ok) {
      const list = orderRes.data.orders ?? []
      setOrders(list)
      // 需求 §16：用户付了钱但没点「我已完成支付」，后台就不会出现待确认。
      // 所以重新进来时**主动把未完成的订单摆到面前**，而不是让用户自己去列表里翻。
      const outstanding = list.find((o) => o.status === 'PENDING' || o.status === 'PAID')
      if (outstanding) setCurrent(outstanding)
    }
    if (!cfgRes.ok && !balRes.ok && !orderRes.ok) {
      setError(cfgRes.message)
    }
    setLoading(false)
  }, [])

  /**
   * 轻量刷新：只拉订单与余额，不切 loading（轮询时页面不该闪）。
   * 当前跟进的订单以服务端返回为准——管理员一确认，状态与积分自己就变过来。
   */
  const tick = useCallback(async () => {
    const [balRes, orderRes] = await Promise.all([
      api<{ balance: number | null }>('/api/user/balance'),
      api<{ orders: RechargeOrder[] }>('/api/recharge/orders'),
    ])
    if (balRes.ok && typeof balRes.data.balance === 'number') setBalance(balRes.data.balance)
    if (!orderRes.ok) return
    const list = orderRes.data.orders ?? []
    setOrders(list)
    setCurrent((prev) => (prev ? list.find((o) => o.id === prev.id) ?? prev : prev))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 自动刷新：只有存在未结束的订单时才轮询，全部到终态就停（不空转）
  useEffect(() => {
    const hasOpen = orders.some((o) => o.status === 'PENDING' || o.status === 'PAID')
    if (!hasOpen) return
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [orders, tick])

  const amountNumber = Number(amount)
  const pointsPerYuan = config?.pointsPerYuan ?? 20
  const minAmount = config?.minAmount ?? 5
  const maxAmount = config?.maxAmount ?? 5000
  const validAmount =
    Number.isFinite(amountNumber) && amountNumber >= minAmount && amountNumber <= maxAmount
  /** 预计积分（仅展示）：真正的入账积分由服务端按实际到账金额计算 */
  const estimated = validAmount ? estimatePoints(amountNumber, pointsPerYuan) : 0
  // 档位来自服务端配置（需求 §4 禁止把充值规则写死在前端），读不到才用兜底
  const quickAmounts =
    config?.quickAmounts && config.quickAmounts.length > 0 ? config.quickAmounts : FALLBACK_QUICK_AMOUNTS
  // 话术由支付通道给：MANUAL 通道下系统**不知道**钱有没有到，
  // 所以措辞只能是"已提交支付确认"，绝不能出现"支付成功"（需求 §15）
  const provider = getPaymentProvider(current?.provider)

  // 收款码：默认使用项目内置微信二维码；管理员配置会覆盖（用于切换其他收款方式）。
  // 外部 URL 为空/失效/无法解析时自动回退到本地默认图，避免白框。
  const defaultQrImageUrl = '/images/recharge/wechat-pay.png'
  const rawQrImageUrl = config?.payment.qrImageUrl?.trim()
  const qrImageUrl = rawQrImageUrl ? rawQrImageUrl : defaultQrImageUrl
  const qrAlt = `${config?.payment.method ?? '微信'}收款码`

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
        <div className="flex items-center justify-center gap-2 py-24 vs-note">
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
            {current.status === 'PENDING' && <QrCode size={16} className="text-[var(--vs-ink)]" />}
            {current.status === 'PAID' && <Clock size={16} className="vs-note-warn" />}
            {current.status === 'CONFIRMED' && <CheckCircle2 size={16} className="text-[var(--vs-ink)]" />}
            {(current.status === 'REJECTED' || current.status === 'CANCELLED') && (
              <XCircle size={16} className="text-[var(--vs-ink-3)]" />
            )}
            <span className="text-[14px] font-medium text-[var(--vs-ink)]">
              {current.status === 'PENDING' && '请使用收款码付款'}
              {current.status === 'PAID' && '已提交支付确认，等待管理员确认'}
              {current.status === 'CONFIRMED' && provider.confirmedMessage}
              {current.status === 'REJECTED' && '管理员未收到该笔款项'}
              {current.status === 'CANCELLED' && '订单已取消'}
            </span>
          </div>

          {/* 需求 §5/§15：用户声明已付款 ≠ 系统确认收款，措辞必须如实 */}
          {current.status === 'PAID' && (
            <p className="vs-frame mt-4 px-4 py-3 text-[13px] leading-relaxed text-[var(--vs-ink)]">
              {provider.submittedMessage}
            </p>
          )}

          {current.status === 'PENDING' && (
            <div className="mt-5 flex flex-col items-center">
              {/*
                默认使用项目内置微信收款码。
                管理员若配置了其他通道的二维码，config.payment.qrImageUrl 会覆盖默认图。
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrImageUrl}
                alt={qrAlt}
                className="h-[240px] w-[240px] rounded-xl border border-[var(--vs-line)] bg-white object-contain"
                onError={(e) => {
                  // 外部 URL 失效/无法解析时回退到本地二维码
                  if (e.currentTarget.src !== defaultQrImageUrl) {
                    e.currentTarget.src = defaultQrImageUrl
                  }
                }}
              />
              {config?.payment.instruction && (
                <p className="mt-4 max-w-md text-center text-[13px] leading-relaxed text-[var(--vs-ink-3)]">
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
                  : `${estimatePoints(current.requestedAmount, pointsPerYuan)} 积分`
              }
            />
            {current.status === 'CONFIRMED' && current.confirmedAmount !== null && (
              <Row label="实际到账金额" value={`${current.confirmedAmount} 元`} />
            )}
            <Row label="状态" value={ORDER_STATUS_TEXT[current.status]} />
            {current.adminNote && <Row label="管理员备注" value={current.adminNote} />}
          </div>

          {current.status === 'CONFIRMED' && (
            <p className="vs-frame mt-4 px-4 py-3 text-[13px] text-[var(--vs-ink)]">
              {provider.confirmedMessage}
              {current.points !== null ? `，${current.points} 积分已到账。` : '，积分已到账。'}
              {current.confirmedAmount !== null && current.confirmedAmount !== current.requestedAmount
                ? `（按实际到账 ${current.confirmedAmount} 元计算）`
                : ''}
            </p>
          )}
          {current.status === 'REJECTED' && (
            <p className="vs-note vs-note-warn vs-warn mt-4">
              管理员未收到该笔款项，积分未增加。如已付款请联系管理员核对。
            </p>
          )}

          {actionError && (
            <p className="vs-error mt-4">{actionError}</p>
          )}

          <div className="mt-5 flex flex-wrap gap-2.5">
            {current.status === 'PENDING' && (
              <>
                <button
                  onClick={markPaid}
                  disabled={submitting}
                  className="vs-btn vs-btn-primary disabled:opacity-50"
                >
                  {submitting && <Loader2 size={14} className="animate-spin" />}
                  我已完成支付
                </button>
                <button
                  onClick={cancelOrder}
                  disabled={submitting}
                  className="vs-btn vs-btn-ghost disabled:opacity-50"
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
                className="vs-btn vs-btn-ghost"
              >
                {current.status === 'PAID' ? '返回（可稍后查看状态）' : '完成'}
              </button>
            )}
          </div>
        </SurfaceCard>
      ) : (
        /* ── 无跟进订单：展示充值表单 ── */
        <SurfaceCard tone="raised">
          <p className="text-[14px] font-medium text-[var(--vs-ink)]">选择充值金额</p>

          <div className="mt-4 flex flex-wrap gap-2">
            {quickAmounts.map((v) => (
              <button
                key={v}
                onClick={() => setAmount(String(v))}
                className={`rounded-xl border px-4 py-2 text-sm transition ${
                  Number(amount) === v
                    ? 'border-[var(--vs-beam-line)] bg-[var(--vs-beam-wash)] text-[var(--vs-ink)]'
                    : 'border-[var(--vs-line)] text-[var(--vs-ink-2)] hover:border-white/20 hover:text-[var(--vs-ink)]'
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
              className="vs-input vs-input-field w-40"
            />
            <span className="vs-note">元</span>
            <span className="ml-auto text-[14px] text-[var(--vs-ink-2)]">
              预计获得 <span className="font-semibold text-[var(--vs-ink)]">{estimated}</span> 积分
            </span>
          </div>

          <p className="mt-2 vs-note leading-relaxed">
            最低 {minAmount} 元，单笔上限 {maxAmount} 元。预计积分为展示值，
            最终以管理员核实的实际到账金额计算。
          </p>

          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="备注（可选，例如付款账号后四位，便于管理员核对）"
            aria-label="充值备注"
            className="vs-input vs-input-field mt-4 w-full"
          />

          {actionError && <p className="vs-error mt-3">{actionError}</p>}

          <button
            onClick={submitOrder}
            disabled={!validAmount || submitting}
            className="vs-btn vs-btn-primary mt-5 disabled:opacity-50"
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
                <span className="font-mono vs-note">{o.orderNo}</span>
                <span className="text-[13px] text-[var(--vs-ink-2)]">{o.requestedAmount} 元</span>
                <span className="text-[13px] text-[var(--vs-ink-4)]">
                  {o.points !== null ? `${o.points} 积分` : `≈ ${estimatePoints(o.requestedAmount, pointsPerYuan)} 积分`}
                </span>
                <span className="vs-note ml-auto">
                  {ORDER_STATUS_TEXT[o.status]}
                </span>
                <button
                  onClick={() => setCurrent(o)}
                  className="vs-link text-[12px]"
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
      <span className="shrink-0 text-[var(--vs-ink-4)]">{label}</span>
      <span className="text-right text-[var(--vs-ink)]">{value}</span>
    </div>
  )
}
