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
import {
  CONSISTENCY_VERDICT_META,
  type ConsistencyCheck,
  type ConsistencyItem,
} from '@/lib/creative/consistencyCheck'

interface DiagnosisCardProps {
  diagnosis?: CreativeDiagnosis | null
  loading?: boolean // 首次诊断进行中
  error?: string | null
  onRetry?: () => void // 失败后重试
  onRefresh?: () => void // 已有诊断时强制重新诊断
  refreshing?: boolean
  /** 创作一致性三问（服务端算，作品页透传；没有可判定结论时整块不渲染） */
  consistency?: ConsistencyCheck | null
}

/** 三问的展示顺序与中文标题 */
const CONSISTENCY_ROWS: Array<{ key: keyof Omit<ConsistencyCheck, 'hasAnySignal'>; label: string }> = [
  { key: 'knowledge', label: '是否符合你的知识' },
  { key: 'interest', label: '是否符合你的兴趣' },
  { key: 'viewpoint', label: '是否踩到你的禁忌' },
]

const TONE_CLASS: Record<'good' | 'warn' | 'bad' | 'muted', string> = {
  good: 'text-[var(--vs-ink)]',
  warn: 'text-[var(--vs-warn)]',
  bad: 'text-[var(--vs-danger)]',
  muted: 'text-[var(--vs-ink-4)]',
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
        <span className="vs-h3">{label}</span>
        <span className="vs-note">{hint}</span>
      </div>
      <div className="mt-2.5 space-y-2">
        {good && (
          <p className="flex gap-2 text-[13px] leading-relaxed text-[var(--vs-ink-2)]">
            <span className="shrink-0 text-[var(--vs-ink-3)]">✓</span>
            <span>{good}</span>
          </p>
        )}
        {fix && (
          <p className="flex gap-2 text-[13px] leading-relaxed text-[var(--vs-ink-2)]">
            <span className="shrink-0 text-[var(--vs-warn)]">✎</span>
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
          tone === 'good' ? 'text-[var(--vs-ink)]' : 'text-[var(--vs-warn)]'
        }`}
      >
        {tone === 'good' ? '✓' : '✎'} {title}
      </p>
      {items.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {items.map((item, i) => (
            <li
              key={i}
              className="flex gap-2 text-[13px] leading-relaxed text-[var(--vs-ink-2)]"
            >
              <span className="shrink-0 text-[var(--vs-ink-4)]">{i + 1}.</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-[var(--vs-ink-4)]">本次未发现明显项</p>
      )}
    </div>
  )
}

/** 单条一致性结论（结论文案 + 命中项，不用数字分数避免伪精确） */
function ConsistencyRow({ label, item }: { label: string; item: ConsistencyItem }) {
  const meta = CONSISTENCY_VERDICT_META[item.verdict]
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-medium text-[var(--vs-ink)]">{label}</span>
        <span className={`text-[11px] ${TONE_CLASS[meta.tone]}`}>{meta.label}</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--vs-ink-4)]">{item.detail}</p>
      {item.hits.length > 0 && (
        <p className="mt-1 vs-note">命中：{item.hits.join('、')}</p>
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
  consistency = null,
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
          <Sparkles size={14} className="shrink-0 text-[var(--vs-ink)]" />
          <span className="vs-h3">AI 诊断</span>
          <span className="truncate vs-note">
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
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 py-1 text-[12px] text-[var(--vs-ink-3)] transition hover:border-white/20 hover:text-[var(--vs-ink)] disabled:opacity-40"
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

        {/* 创作一致性三问：「好」与「像我」是两件事。
            三镜头诊断回答前者，这块回答后者；无可判定结论时整块不渲染
            —— 不给用户看一堆"暂无法判断"凑数。 */}
        {consistency?.hasAnySignal && (
          <div className="mt-4 border-t border-white/[0.07] pt-3.5">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-[13px] font-medium text-[var(--vs-ink)]">是否符合你</span>
              <span className="vs-note">
                对照你的知识、兴趣与明确排除的内容
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {CONSISTENCY_ROWS.map((row) => (
                <ConsistencyRow
                  key={row.key}
                  label={row.label}
                  item={consistency[row.key]}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </SurfaceCard>
  )
}
