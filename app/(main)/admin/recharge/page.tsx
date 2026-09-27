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
  /** 汇率只用于展示「预计获得积分」；真正入账的积分由服务端按实际到账金额算 */
  const [pointsPerYuan, setPointsPerYuan] = useState<number>(20)

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
    const [orderRes, cfgRes] = await Promise.all([
      api<{ orders: RechargeOrder[]; emails: Record<string, string> }>(
        `/api/admin/recharge?status=${filter}&limit=50`
      ),
      api<RechargeConfig>('/api/recharge/config'),
    ])
    if (!orderRes.ok) {
      setError(orderRes.message)
      setOrders([])
    } else {
      setOrders(orderRes.data.orders ?? [])
      setEmails(orderRes.data.emails ?? {})
    }
    if (cfgRes.ok && typeof cfgRes.data.pointsPerYuan === 'number') {
      setPointsPerYuan(cfgRes.data.pointsPerYuan)
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
          {/* 需求 §7：管理员一进来先看到「待确认 N」，这就是他今天要干的活 */}
          <StatRow
            items={[
              { label: '待确认', value: pendingCount, hint: '用户已声明付款，等你核实' },
              { label: '当前列表订单', value: orders.length },
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
                    ? 'border-[var(--vs-beam-line)] bg-[var(--vs-beam-wash)] text-[var(--vs-ink)]'
                    : 'border-[var(--vs-line)] text-[var(--vs-ink-2)] hover:border-white/20 hover:text-[var(--vs-ink)]'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="h-6" />

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 vs-note">
              <Loader2 size={16} className="animate-spin" />
              正在加载订单…
            </div>
          ) : orders.length === 0 ? (
            <EmptyState compact title="没有符合条件的订单" description="换一个筛选条件试试。" />
          ) : (
            <Section title={filter === 'PAID' ? '待确认充值' : '订单列表'}>
              <div className="space-y-2.5">
                {orders.map((o) => (
                  <div
                    key={o.id}
                    className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                      <span className="font-mono vs-note">{o.orderNo}</span>
                      <span className="text-[13px] text-[var(--vs-ink-2)]">
                        {emails[o.userId] ?? `用户 ${o.userId.slice(0, 8)}`}
                      </span>
                      <span className="text-[13px] text-[var(--vs-ink-3)]">申请 {o.requestedAmount} 元</span>
                      <span className="vs-note ml-auto">
                        {ORDER_STATUS_TEXT[o.status]}
                      </span>
                      <span className="text-[12px] text-[var(--vs-ink-4)]">
                        {o.createdAt ? new Date(o.createdAt).toLocaleString('zh-CN') : ''}
                      </span>
                    </div>

                    {o.userNote && (
                      <p className="vs-note mt-1.5">用户备注：{o.userNote}</p>
                    )}
                    {o.status === 'CONFIRMED' && (
                      <p className="vs-note mt-1.5">
                        实际到账 {o.confirmedAmount} 元 → {o.points} 积分
                      </p>
                    )}
                    {o.adminNote && (
                      <p className="vs-note mt-1.5">管理员备注：{o.adminNote}</p>
                    )}

                    {(o.status === 'PENDING' || o.status === 'PAID') && (
                      <div className="mt-2.5">
                        <button
                          onClick={() => setSelected(o)}
                          className="vs-link text-[12px]"
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
                <p className="text-[14px] font-medium text-[var(--vs-ink)]">
                  处理订单 {selected.orderNo}
                </p>

                {/* 需求 §7：核账需要的字段一次给全——
                    「获得积分」是**按申报金额预计**的值，真正入账以你填的实际到账金额为准 */}
                <div className="mt-4 space-y-2 text-[13px]">
                  <Row label="用户" value={emails[selected.userId] ?? `用户 ${selected.userId.slice(0, 8)}`} />
                  <Row label="订单号" value={selected.orderNo} />
                  <Row label="申报金额" value={`${selected.requestedAmount} 元`} />
                  <Row
                    label="获得积分"
                    value={
                      selected.points !== null
                        ? `${selected.points} 积分（已入账）`
                        : `约 ${estimatePoints(selected.requestedAmount, pointsPerYuan)} 积分（按实际到账计算）`
                    }
                  />
                  <Row label="创建时间" value={formatTime(selected.createdAt)} />
                  <Row
                    label="提交已付款时间"
                    value={selected.paidAt ? formatTime(selected.paidAt) : '尚未提交'}
                  />
                  <Row label="当前状态" value={ORDER_STATUS_TEXT[selected.status as OrderStatus]} />
                  {selected.userNote && <Row label="用户备注" value={selected.userNote} />}
                </div>

                <div className="mt-5 flex items-center gap-3">
                  <label className="text-[13px] text-[var(--vs-ink-3)]" htmlFor="confirmed-amount">
                    实际到账金额
                  </label>
                  <input
                    id="confirmed-amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    type="number"
                    min={0}
                    step={0.01}
                    className="vs-input vs-input-field w-36"
                  />
                  <span className="vs-note">元</span>
                </div>

                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={200}
                  placeholder="备注（可选，例如：微信转账已核对 / 未收到该笔款项）"
                  aria-label="管理员备注"
                  className="mt-3 vs-input vs-input-field w-full placeholder:text-[var(--vs-ink-5)]"
                />

                {feedback && (
                  <p
                    className={`mt-3 text-[13px] ${
                      feedback.ok ? 'text-[var(--vs-ink)]' : 'vs-error-text'
                    }`}
                  >
                    {feedback.message}
                  </p>
                )}

                <div className="mt-5 flex flex-wrap gap-2.5">
                  <button
                    onClick={confirm}
                    disabled={busy}
                    className="vs-btn vs-btn-primary disabled:opacity-50"
                  >
                    {busy && <Loader2 size={14} className="animate-spin" />}
                    <CheckCircle2 size={15} />
                    确认到账
                  </button>
                  <button
                    onClick={reject}
                    disabled={busy}
                    className="vs-btn vs-btn-danger disabled:opacity-50"
                  >
                    <XCircle size={15} />
                    拒绝（未收到款）
                  </button>
                  <button
                    onClick={() => setSelected(null)}
                    className="vs-btn vs-btn-ghost"
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
                  ? 'border-[var(--vs-line)] bg-[var(--vs-void-1)] text-[var(--vs-ink)]'
                  : 'vs-verdict vs-note-warn'
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

function formatTime(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 键值行：订单详情里反复用到 */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-[var(--vs-ink-4)]">{label}</span>
      <span className="text-right text-[var(--vs-ink)]">{value}</span>
    </div>
  )
}
