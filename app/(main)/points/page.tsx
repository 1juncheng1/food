'use client'

// ────────────────────────────────────────────────────────────
// 我的积分 /points
//
// 余额 + 流水。人工收款模式下这张页是用户的"对账单"：
// 充值什么时候到的账、AI 每一次花了多少、管理员有没有调整过，
// 全都列在这里，不需要去找人问。
//
// 展示纪律：金额一律带符号（+/-），并同时给出变动前后余额——
// 只有"变了 20"看不出问题，看到"100 → 120"才能核对。
// ────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, Wallet } from 'lucide-react'
import { getValidSession } from '@/lib/supabaseClient'
import type { LedgerEntry, LedgerType } from '@/lib/points'
import {
  EmptyState,
  ErrorState,
  PageHeader,
  PageShell,
  Section,
  SkeletonList,
  StatRow,
  SurfaceCard,
} from '@/components/vision'

/** 流水类型 → 用户可读文案 */
const LEDGER_TEXT: Record<LedgerType, string> = {
  REGISTER_BONUS: '注册赠送',
  RECHARGE: '充值到账',
  AI_CONSUMPTION: 'AI 消费',
  MANUAL_ADJUSTMENT: '管理员调整',
  REFUND: '退款退回',
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function PointsPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [pointsPerYuan, setPointsPerYuan] = useState<number | null>(null)
  const [entries, setEntries] = useState<LedgerEntry[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const session = await getValidSession()
    if (!session) {
      setError('请先登录后再查看积分')
      setLoading(false)
      return
    }
    const headers = { Authorization: `Bearer ${session.access_token}` }
    try {
      const [balRes, ledgerRes] = await Promise.all([
        fetch('/api/user/balance', { headers }),
        fetch('/api/user/points/ledger?limit=50', { headers }),
      ])
      if (balRes.ok) {
        const d = (await balRes.json()) as { balance?: unknown; pointsPerYuan?: unknown }
        if (typeof d.balance === 'number') setBalance(d.balance)
        if (typeof d.pointsPerYuan === 'number' && d.pointsPerYuan > 0) {
          setPointsPerYuan(d.pointsPerYuan)
        }
      }
      if (ledgerRes.ok) {
        const d = (await ledgerRes.json()) as { entries?: LedgerEntry[] }
        setEntries(Array.isArray(d.entries) ? d.entries : [])
      }
      if (!balRes.ok && !ledgerRes.ok) {
        setError('无法加载积分信息，请稍后重试')
      }
    } catch {
      setError('网络异常，请稍后重试')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <PageShell width="narrow">
        <div className="py-10">
          <SkeletonList count={5} />
        </div>
      </PageShell>
    )
  }

  if (error) {
    return (
      <PageShell width="narrow">
        <ErrorState title="无法加载积分信息" message={error} onRetry={load} />
      </PageShell>
    )
  }

  return (
    <PageShell width="narrow">
      <PageHeader
        eyebrow="账户"
        title="我的积分"
        description="每一笔积分的变化都记在这里：充值到账、AI 消费、管理员调整、退款退回。"
      />

      <StatRow
        items={[
          { label: '当前积分', value: balance ?? '—' },
          { label: '汇率', value: pointsPerYuan ? `1 元 = ${pointsPerYuan} 积分` : '—' },
        ]}
        className="grid-cols-2 sm:grid-cols-2"
      />

      <div className="h-6" />

      <SurfaceCard>
        <Link
          href="/recharge"
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500"
        >
          <Wallet size={15} />
          去充值
        </Link>
      </SurfaceCard>

      <div className="h-10" />

      <Section title="积分流水" description="变动后余额可与上一笔的变动前余额核对，中间不应出现断档。">
        {entries.length === 0 ? (
          <EmptyState
            compact
            icon={<Wallet size={18} />}
            title="还没有积分变动记录"
            description="注册赠送、充值到账、AI 消费都会出现在这里。"
          />
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div
                key={e.id}
                className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[13px] font-medium text-zinc-200">
                    {LEDGER_TEXT[e.type]}
                  </span>
                  <span
                    className={`text-[13px] font-semibold ${
                      e.amount >= 0 ? 'text-emerald-300' : 'text-zinc-300'
                    }`}
                  >
                    {e.amount >= 0 ? '+' : ''}
                    {e.amount}
                  </span>
                  <span className="ml-auto text-[12px] text-zinc-500">{formatTime(e.createdAt)}</span>
                </div>
                <p className="mt-1 text-[12px] text-zinc-500">
                  余额 {e.balanceBefore} → {e.balanceAfter}
                  {e.description ? ` · ${e.description}` : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </Section>
    </PageShell>
  )
}
