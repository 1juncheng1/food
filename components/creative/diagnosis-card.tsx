// AI 作品诊断卡：从「观点 / 证据 / 表达」三个镜头读一篇作品。
// 旧诊断（库内历史 jsonb 没有 lenses 字段）自动回退到「表现良好 / 需要改进」两段，
// 保证任何历史作品都有内容可看，不会因为升级而变空。
// 纯展示组件：数据获取与重试由 article 页控制。

'use client'

import { RefreshCw, Sparkles } from 'lucide-react'
import { AiStatus, ErrorState, SkeletonText, SurfaceCard } from '@/components/vision'
import {
  DIAGNOSIS_LENS_META,
  type CreativeDiagnosis,
} from '@/lib/creative/diagnosisMeta'

interface DiagnosisCardProps {
  diagnosis?: CreativeDiagnosis | null
  loading?: boolean // 首次诊断进行中
  error?: string | null
  onRetry?: () => void // 失败后重试
  onRefresh?: () => void // 已有诊断时强制重新诊断
  refreshing?: boolean
}

/** 单个镜头：好在哪 / 该怎么改 */
function LensBlock({
  label,
  hint,
  good,
  fix,
}: {
  label: string
  hint: string
  good: string
  fix: string
}) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[14px] font-semibold text-zinc-100">{label}</span>
        <span className="text-[11px] text-zinc-600">{hint}</span>
      </div>
      <div className="mt-2.5 space-y-2">
        {good && (
          <p className="flex gap-2 text-[13px] leading-relaxed text-zinc-300">
            <span className="shrink-0 text-emerald-400/90">✓</span>
            <span>{good}</span>
          </p>
        )}
        {fix && (
          <p className="flex gap-2 text-[13px] leading-relaxed text-zinc-300">
            <span className="shrink-0 text-amber-400/90">✎</span>
            <span>{fix}</span>
          </p>
        )}
      </div>
    </div>
  )
}

/** 回退视图：旧诊断只有两段 */
function LegacyList({
  title,
  tone,
  items,
}: {
  title: string
  tone: 'good' | 'fix'
  items: string[]
}) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3.5">
      <p
        className={`text-[13px] font-medium ${
          tone === 'good' ? 'text-emerald-400' : 'text-amber-400'
        }`}
      >
        {tone === 'good' ? '✓' : '✎'} {title}
      </p>
      {items.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {items.map((item, i) => (
            <li
              key={i}
              className="flex gap-2 text-[13px] leading-relaxed text-zinc-300"
            >
              <span className="shrink-0 text-zinc-600">{i + 1}.</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-zinc-600">本次未发现明显项</p>
      )}
    </div>
  )
}

export function DiagnosisCard({
  diagnosis,
  loading = false,
  error = null,
  onRetry,
  onRefresh,
  refreshing = false,
}: DiagnosisCardProps) {
  const lenses = diagnosis?.lenses
  const hasLenses =
    !!lenses && DIAGNOSIS_LENS_META.some((m) => !!lenses[m.key])

  if (loading) {
    return (
      <SurfaceCard tone="ai">
        <AiStatus task="diagnose" active variant="steps" className="border-0 bg-transparent p-0" />
        <div className="mt-3">
          <SkeletonText lines={3} />
        </div>
      </SurfaceCard>
    )
  }

  if (error || !diagnosis) {
    return (
      <ErrorState
        title="这次诊断没能完成"
        message={error ?? '暂无诊断结果'}
        onRetry={onRetry}
        retryLabel="重新诊断"
      />
    )
  }

  return (
    <SurfaceCard tone="ai" padded={false}>
      {/* 头部 */}
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles size={14} className="shrink-0 text-indigo-300" />
          <span className="text-[14px] font-semibold text-zinc-100">AI 诊断</span>
          <span className="truncate text-[11px] text-zinc-600">
            {new Date(diagnosis.diagnosedAt).toLocaleString('zh-CN', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 py-1 text-[12px] text-zinc-400 transition hover:border-white/20 hover:text-zinc-200 disabled:opacity-40"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? '重新诊断中…' : '重新诊断'}
          </button>
        )}
      </div>

      <div className="px-5 py-4">
        {hasLenses ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {DIAGNOSIS_LENS_META.map((m) => {
              const lens = lenses?.[m.key]
              if (!lens) return null
              return (
                <LensBlock
                  key={m.key}
                  label={m.label}
                  hint={m.hint}
                  good={lens.good}
                  fix={lens.fix}
                />
              )
            })}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <LegacyList title="表现良好" tone="good" items={diagnosis.strengths} />
            <LegacyList title="需要改进" tone="fix" items={diagnosis.improvements} />
          </div>
        )}
      </div>
    </SurfaceCard>
  )
}
