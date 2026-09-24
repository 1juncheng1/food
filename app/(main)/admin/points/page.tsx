'use client'

// ────────────────────────────────────────────────────────────
// 积分管理 /admin/points（管理员）
//
// 三件事：手动调分、配置收款码、改价格。
//
// 改价格这一块是需求 §21 的落点：以后 API 成本涨了、或者搞活动送 10%，
// 在这里改一个数就行，**不用改代码、不用重新部署**。
// ────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Save, Wallet } from 'lucide-react'
import { getValidSession } from '@/lib/supabaseClient'
import type { RechargeConfig } from '@/lib/recharge'
import {
  ErrorState,
  PageHeader,
  PageShell,
  Section,
  SurfaceCard,
} from '@/components/vision'

/** 常见调整原因：一键填入，避免管理员每次手打 */
const QUICK_REASONS = ['补偿用户', '测试修正', '活动奖励', '退款'] as const

type Feedback = { ok: boolean; message: string }

export default function AdminPointsPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [config, setConfig] = useState<RechargeConfig | null>(null)

  // 手动调分
  const [targetUser, setTargetUser] = useState('')
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')
  const [adjusting, setAdjusting] = useState(false)
  const [adjustFeedback, setAdjustFeedback] = useState<Feedback | null>(null)

  // 收款码配置
  const [method, setMethod] = useState('微信')
  const [qrUrl, setQrUrl] = useState('')
  const [accountName, setAccountName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [savingPayment, setSavingPayment] = useState(false)
  const [paymentFeedback, setPaymentFeedback] = useState<Feedback | null>(null)

  // 价格配置
  const [pointsPerYuan, setPointsPerYuan] = useState('20')
  const [minAmount, setMinAmount] = useState('5')
  const [maxAmount, setMaxAmount] = useState('5000')
  const [savingConfig, setSavingConfig] = useState(false)
  const [configFeedback, setConfigFeedback] = useState<Feedback | null>(null)

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
    if (!res.ok) return { ok: false, message: json?.error ?? '操作失败，请稍后重试' }
    return { ok: true, data: json as T }
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const res = await api<RechargeConfig>('/api/recharge/config')
    if (!res.ok) {
      setError(res.message)
    } else {
      setConfig(res.data)
      setMethod(res.data.payment.method || '微信')
      setQrUrl(res.data.payment.qrImageUrl ?? '')
      setAccountName(res.data.payment.accountName ?? '')
      setInstruction(res.data.payment.instruction ?? '')
      setPointsPerYuan(String(res.data.pointsPerYuan))
      setMinAmount(String(res.data.minAmount))
      setMaxAmount(String(res.data.maxAmount))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function submitAdjust() {
    const d = Number(delta)
    if (!targetUser.trim()) {
      setAdjustFeedback({ ok: false, message: '请填写用户 ID' })
      return
    }
    if (!Number.isFinite(d) || d === 0) {
      setAdjustFeedback({ ok: false, message: '调整积分必须是非零数字（增加为正，扣减为负）' })
      return
    }
    if (!reason.trim()) {
      setAdjustFeedback({ ok: false, message: '请填写调整原因' })
      return
    }
    setAdjusting(true)
    setAdjustFeedback(null)
    const res = await api<{ balance: number; referenceId: string }>('/api/admin/points/adjust', {
      method: 'POST',
      body: JSON.stringify({ userId: targetUser.trim(), delta: d, reason: reason.trim() }),
    })
    setAdjusting(false)
    setAdjustFeedback(
      res.ok
        ? { ok: true, message: `已调整，用户当前余额 ${res.data.balance} 积分（单号 ${res.data.referenceId}）` }
        : { ok: false, message: res.message }
    )
  }

  async function savePayment() {
    setSavingPayment(true)
    setPaymentFeedback(null)
    const res = await api<{ ok: boolean }>('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        payment: { method, qrImageUrl: qrUrl.trim(), accountName: accountName.trim(), instruction: instruction.trim() },
      }),
    })
    setSavingPayment(false)
    setPaymentFeedback(
      res.ok ? { ok: true, message: '收款码配置已保存，用户端立即生效' } : { ok: false, message: res.message }
    )
  }

  async function saveConfig() {
    const ppy = Number(pointsPerYuan)
    if (!Number.isFinite(ppy) || ppy <= 0) {
      setConfigFeedback({ ok: false, message: '汇率必须是大于 0 的数字' })
      return
    }
    setSavingConfig(true)
    setConfigFeedback(null)
    // 逐项保存：point_config 是键值表，一次改一个键，失败不影响其它键
    const tasks = [
      api('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ config: { key: 'POINTS_PER_YUAN', value: ppy } }),
      }),
      api('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ config: { key: 'MIN_RECHARGE_AMOUNT', value: Number(minAmount) } }),
      }),
      api('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ config: { key: 'MAX_RECHARGE_AMOUNT', value: Number(maxAmount) } }),
      }),
    ]
    const results = await Promise.all(tasks)
    setSavingConfig(false)
    const failed = results.filter((r) => !r.ok)
    setConfigFeedback(
      failed.length === 0
        ? { ok: true, message: '价格配置已保存（进程内缓存最多 60 秒后全量生效）' }
        : { ok: false, message: `有 ${failed.length} 项保存失败，请重试` }
    )
  }

  if (loading) {
    return (
      <PageShell width="default">
        <div className="flex items-center justify-center gap-2 py-24 text-sm text-zinc-500">
          <Loader2 size={16} className="animate-spin" />
          正在加载配置…
        </div>
      </PageShell>
    )
  }

  if (error) {
    return (
      <PageShell width="default">
        <ErrorState title="无法加载管理后台" message={error} onRetry={load} />
      </PageShell>
    )
  }

  return (
    <PageShell width="default">
      <PageHeader
        eyebrow="管理后台"
        title="积分管理"
        description="手动调整用户积分、配置收款码、调整价格。每一次调整都会写入积分流水，可随时追溯。"
      />

      {/* ── 手动调整积分 ── */}
      <Section title="手动调整积分" description="增加为正数、扣减为负数。必须填写原因，调整会写入积分流水。">
        <SurfaceCard>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[260px] flex-1">
              <label className="mb-1.5 block text-[12px] text-zinc-500" htmlFor="target-user">
                用户 ID
              </label>
              <input
                id="target-user"
                value={targetUser}
                onChange={(e) => setTargetUser(e.target.value)}
                placeholder="auth.users 的 uuid"
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-500/40"
              />
            </div>
            <div className="w-32">
              <label className="mb-1.5 block text-[12px] text-zinc-500" htmlFor="delta">
                积分增减
              </label>
              <input
                id="delta"
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                type="number"
                step={1}
                placeholder="+100 / -50"
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-500/40"
              />
            </div>
            <button
              onClick={submitAdjust}
              disabled={adjusting}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {adjusting && <Loader2 size={14} className="animate-spin" />}
              提交调整
            </button>
          </div>

          <div className="mt-4">
            <label className="mb-1.5 block text-[12px] text-zinc-500" htmlFor="reason">
              原因（必填）
            </label>
            <input
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              placeholder="例如：补偿用户 / 测试修正 / 活动奖励 / 退款"
              className="w-full rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-500/40"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {QUICK_REASONS.map((r) => (
                <button
                  key={r}
                  onClick={() => setReason(r)}
                  className="rounded-lg border border-white/[0.1] px-3 py-1 text-[12px] text-zinc-400 transition hover:border-white/20 hover:text-zinc-200"
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {adjustFeedback && (
            <p className={`mt-3 text-[13px] ${adjustFeedback.ok ? 'text-emerald-300' : 'text-red-300'}`}>
              {adjustFeedback.message}
            </p>
          )}
        </SurfaceCard>
      </Section>

      <div className="h-10" />

      {/* ── 收款码配置 ── */}
      <Section title="收款码配置" description="用户充值页展示的收款方式、二维码与说明。">
        <SurfaceCard>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-[12px] text-zinc-500" htmlFor="pay-method">
                收款方式
              </label>
              <input
                id="pay-method"
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                maxLength={40}
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-indigo-500/40"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] text-zinc-500" htmlFor="pay-account">
                收款账户名（可选）
              </label>
              <input
                id="pay-account"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                maxLength={60}
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-indigo-500/40"
              />
            </div>
          </div>

          <div className="mt-4">
            <label className="mb-1.5 block text-[12px] text-zinc-500" htmlFor="pay-qr">
              二维码图片地址（http/https）
            </label>
            <input
              id="pay-qr"
              value={qrUrl}
              onChange={(e) => setQrUrl(e.target.value)}
              placeholder="https://..."
              className="w-full rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-500/40"
            />
          </div>

          <div className="mt-4">
            <label className="mb-1.5 block text-[12px] text-zinc-500" htmlFor="pay-instruction">
              收款说明
            </label>
            <textarea
              id="pay-instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              maxLength={300}
              rows={2}
              className="w-full rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-indigo-500/40"
            />
          </div>

          <button
            onClick={savePayment}
            disabled={savingPayment}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {savingPayment && <Loader2 size={14} className="animate-spin" />}
            <Save size={15} />
            保存收款配置
          </button>

          {paymentFeedback && (
            <p className={`mt-3 text-[13px] ${paymentFeedback.ok ? 'text-emerald-300' : 'text-red-300'}`}>
              {paymentFeedback.message}
            </p>
          )}
        </SurfaceCard>
      </Section>

      <div className="h-10" />

      {/* ── 价格配置 ── */}
      <Section
        title="价格配置"
        description="改这里就能调价，不需要改代码。汇率变更只影响之后的充值与消费，不追溯历史。"
      >
        <SurfaceCard>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-[12px] text-zinc-500" htmlFor="cfg-ppy">
                1 元 = ? 积分
              </label>
              <input
                id="cfg-ppy"
                value={pointsPerYuan}
                onChange={(e) => setPointsPerYuan(e.target.value)}
                type="number"
                min={1}
                step={1}
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-indigo-500/40"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] text-zinc-500" htmlFor="cfg-min">
                最低充值（元）
              </label>
              <input
                id="cfg-min"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
                type="number"
                min={0}
                step={1}
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-indigo-500/40"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] text-zinc-500" htmlFor="cfg-max">
                单笔上限（元）
              </label>
              <input
                id="cfg-max"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
                type="number"
                min={1}
                step={1}
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-indigo-500/40"
              />
            </div>
          </div>

          <p className="mt-3 inline-flex items-center gap-2 text-[12px] text-zinc-500">
            <Wallet size={13} />
            当前：1 元 = {config?.pointsPerYuan ?? 20} 积分，注册赠送{' '}
            {config?.registerBonusPoints ?? 20} 积分
          </p>

          <div className="mt-4">
            <button
              onClick={saveConfig}
              disabled={savingConfig}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {savingConfig && <Loader2 size={14} className="animate-spin" />}
              <Save size={15} />
              保存价格配置
            </button>
          </div>

          {configFeedback && (
            <p className={`mt-3 text-[13px] ${configFeedback.ok ? 'text-emerald-300' : 'text-red-300'}`}>
              {configFeedback.message}
            </p>
          )}
        </SurfaceCard>
      </Section>
    </PageShell>
  )
}
