'use client'

// ────────────────────────────────────────────────────────────
// 充值订单管理 /admin/recharge（管理员）
//
// 核账页面最重要的两点：
//   1. 管理员填的是**实际到账金额**，不是用户申请金额。
//      用户申请 10 元、实际到账 20 元，就填 20，系统按 20 算积分。
//   2. 重复点「确认到账」不会重复充值：服务端会用订单状态 + 流水唯一索引
//      挡住第二次，这里把 duplicated 标记如实显示给管理员，不假装成功。
// ────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { getValidSession } from '@/lib/supabaseClient'
import {
  ORDER_STATUS_TEXT,
  type OrderStatus,
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

type FilterStatus = 'PAID' | 'PENDING' | 'CONFIRMED' | 'ALL'

const FILTERS: { key: FilterStatus; label: string }[] = [
  { key: 'PAID', label: '待确认' },
  { key: 'PENDING', label: '待付款' },
  { key: 'CONFIRMED', label: '已到账' },
  { key: 'ALL', label: '全部' },
]

interface ConfirmFeedback {
  ok: boolean
  message: string
  duplicated?: boolean
}

export default function AdminRechargePage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterStatus>('PAID')
  const [orders, setOrders] = useState<RechargeOrder[]>([])
  const [emails, setEmails] = useState<Record<string, string>>({})

  const [selected, setSelected] = useState<RechargeOrder | null>(null)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<ConfirmFeedback | null>(null)

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
      // 403 = 不是管理员；这类错误必须原样展示，不能兜底成"操作失败"
      return { ok: false, message: json?.error ?? '操作失败，请稍后重试' }
    }
    return { ok: true, data: json as T }
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const res = await api<{ orders: RechargeOrder[]; emails: Record<string, string> }>(
      `/api/admin/recharge?status=${filter}&limit=50`
    )
    if (!res.ok) {
      setError(res.message)
      setOrders([])
    } else {
      setOrders(res.data.orders ?? [])
      setEmails(res.data.emails ?? {})
    }
    setLoading(false)
  }, [filter])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    // 选中订单时，默认填入用户申请金额：多数情况下实际到账就是它，
    // 管理员只需要核对，不必每次重新输入
    if (selected) setAmount(String(selected.requestedAmount))
  }, [selected])

  async function confirm() {
    if (!selected || busy) return
    const n = Number(amount)
    if (!Number.isFinite(n) || n <= 0) {
      setFeedback({ ok: false, message: '请填写实际到账金额' })
      return
    }
    setBusy(true)
    setFeedback(null)
    const res = await api<{ points: number; balance: number; duplicated: boolean }>(
      `/api/admin/recharge/${selected.id}/confirm`,
      { method: 'POST', body: JSON.stringify({ amount: n, note: note.trim() || undefined }) }
    )
    setBusy(false)
    if (!res.ok) {
      setFeedback({ ok: false, message: res.message })
      return
    }
    setFeedback({
      ok: true,
      duplicated: res.data.duplicated,
      message: res.data.duplicated
        ? '该订单此前已确认过，本次未重复增加积分'
        : `已确认到账：入账 ${res.data.points} 积分，用户当前余额 ${res.data.balance}`,
    })
    setSelected(null)
    setNote('')
    void load()
  }

  async function reject() {
    if (!selected || busy) return
    setBusy(true)
    setFeedback(null)
    const res = await api<{ ok: boolean }>(`/api/admin/recharge/${selected.id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ note: note.trim() || undefined }),
    })
    setBusy(false)
    if (!res.ok) {
      setFeedback({ ok: false, message: res.message })
      return
    }
    setFeedback({ ok: true, message: '已标记为未收到款，积分未增加' })
    setSelected(null)
    setNote('')
    void load()
  }

  const pendingCount = orders.filter((o) => o.status === 'PAID').length

  return (
    <PageShell width="default">
      <PageHeader
        eyebrow="管理后台"
        title="充值订单管理"
        description="核对用户付款后确认到账。积分按你填写的**实际到账金额**计算，不是用户的申请金额。"
      />

      {error ? (
        <ErrorState title="无法加载订单" message={error} onRetry={load} />
      ) : (
        <>
          <StatRow
            items={[
              { label: '当前列表订单', value: orders.length },
              { label: '其中待确认', value: pendingCount },
            ]}
            className="grid-cols-2 sm:grid-cols-2"
          />

          <div className="h-8" />

          <div className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-xl border px-4 py-2 text-sm transition ${
                  filter === f.key
                    ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-200'
                    : 'border-white/[0.1] text-zinc-300 hover:border-white/20 hover:text-white'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="h-6" />

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
              <Loader2 size={16} className="animate-spin" />
              正在加载订单…
            </div>
          ) : orders.length === 0 ? (
            <EmptyState compact title="没有符合条件的订单" description="换一个筛选条件试试。" />
          ) : (
            <Section title="订单列表">
              <div className="space-y-2.5">
                {orders.map((o) => (
                  <div
                    key={o.id}
                    className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                      <span className="font-mono text-[12px] text-zinc-500">{o.orderNo}</span>
                      <span className="text-[13px] text-zinc-300">
                        {emails[o.userId] ?? `用户 ${o.userId.slice(0, 8)}`}
                      </span>
                      <span className="text-[13px] text-zinc-400">申请 {o.requestedAmount} 元</span>
                      <span className="ml-auto text-[12px] text-zinc-400">
                        {ORDER_STATUS_TEXT[o.status]}
                      </span>
                      <span className="text-[12px] text-zinc-600">
                        {o.createdAt ? new Date(o.createdAt).toLocaleString('zh-CN') : ''}
                      </span>
                    </div>

                    {o.userNote && (
                      <p className="mt-1.5 text-[13px] text-zinc-500">用户备注：{o.userNote}</p>
                    )}
                    {o.status === 'CONFIRMED' && (
                      <p className="mt-1.5 text-[13px] text-emerald-300/80">
                        实际到账 {o.confirmedAmount} 元 → {o.points} 积分
                      </p>
                    )}
                    {o.adminNote && (
                      <p className="mt-1.5 text-[13px] text-zinc-500">管理员备注：{o.adminNote}</p>
                    )}

                    {(o.status === 'PENDING' || o.status === 'PAID') && (
                      <div className="mt-2.5">
                        <button
                          onClick={() => setSelected(o)}
                          className="text-[12px] text-indigo-300 transition hover:text-indigo-200"
                        >
                          处理该订单
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* ── 处理面板 ── */}
          {selected && (
            <>
              <div className="h-8" />
              <SurfaceCard tone="raised">
                <p className="text-sm font-medium text-zinc-200">
                  处理订单 {selected.orderNo}
                </p>
                <p className="mt-1.5 text-[13px] text-zinc-500">
                  用户申请 {selected.requestedAmount} 元 · 当前状态{' '}
                  {ORDER_STATUS_TEXT[selected.status as OrderStatus]}
                </p>

                <div className="mt-5 flex items-center gap-3">
                  <label className="text-[13px] text-zinc-400" htmlFor="confirmed-amount">
                    实际到账金额
                  </label>
                  <input
                    id="confirmed-amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    type="number"
                    min={0}
                    step={0.01}
                    className="w-36 rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500/40"
                  />
                  <span className="text-sm text-zinc-500">元</span>
                </div>

                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={200}
                  placeholder="备注（可选，例如：微信转账已核对 / 未收到该笔款项）"
                  aria-label="管理员备注"
                  className="mt-3 w-full rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-500/40"
                />

                {feedback && (
                  <p
                    className={`mt-3 text-[13px] ${
                      feedback.ok ? 'text-emerald-300' : 'text-red-300'
                    }`}
                  >
                    {feedback.message}
                  </p>
                )}

                <div className="mt-5 flex flex-wrap gap-2.5">
                  <button
                    onClick={confirm}
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {busy && <Loader2 size={14} className="animate-spin" />}
                    <CheckCircle2 size={15} />
                    确认到账
                  </button>
                  <button
                    onClick={reject}
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 px-4 py-2.5 text-sm font-medium text-red-200 transition hover:border-red-500/50 hover:bg-red-500/10 disabled:opacity-50"
                  >
                    <XCircle size={15} />
                    拒绝（未收到款）
                  </button>
                  <button
                    onClick={() => setSelected(null)}
                    className="inline-flex items-center gap-2 rounded-xl border border-white/[0.1] px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-white/20 hover:text-white"
                  >
                    收起
                  </button>
                </div>
              </SurfaceCard>
            </>
          )}

          {feedback && !selected && (
            <div className="h-6" />
          )}
          {feedback && !selected && (
            <p
              className={`rounded-xl border px-4 py-3 text-[13px] ${
                feedback.ok
                  ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                  : 'border-red-500/25 bg-red-500/10 text-red-200'
              }`}
            >
              {feedback.message}
            </p>
          )}
        </>
      )}
    </PageShell>
  )
}
