'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 全站统一空状态。
 * 原则：空状态不是"没有东西"，而是"下一步该做什么"的引导。
 * 文案必须告诉用户：开始之后系统会因此变得更懂你。
 */
export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
  secondaryLabel,
  secondaryHref,
  onSecondary,
  className,
  compact = false,
}: {
  icon?: ReactNode
  title: string
  description?: string
  actionLabel?: string
  actionHref?: string
  onAction?: () => void
  secondaryLabel?: string
  secondaryHref?: string
  onSecondary?: () => void
  className?: string
  compact?: boolean
}) {
  const primaryBtn =
    actionLabel && (actionHref || onAction) ? (
      actionHref ? (
        <Link href={actionHref} className="vs-btn vs-btn-primary">
          {actionLabel}
        </Link>
      ) : (
        <button onClick={onAction} className="vs-btn vs-btn-primary">
          {actionLabel}
        </button>
      )
    ) : null

  const secondaryBtn =
    secondaryLabel && (secondaryHref || onSecondary) ? (
      secondaryHref ? (
        <Link href={secondaryHref} className="vs-btn vs-btn-ghost">
          {secondaryLabel}
        </Link>
      ) : (
        <button onClick={onSecondary} className="vs-btn vs-btn-ghost">
          {secondaryLabel}
        </button>
      )
    ) : null

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-[var(--vs-r)] border border-dashed border-[var(--vs-line-2)] bg-[var(--vs-void-1)] text-center',
        compact ? 'px-6 py-8' : 'px-6 py-14',
        className
      )}
    >
      {icon && (
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-[var(--vs-r)] border border-[var(--vs-line)] bg-[var(--vs-surface)] text-[var(--vs-ink-3)]">
          {icon}
        </div>
      )}
      <p className="text-[15px] font-medium text-[var(--vs-ink)]">{title}</p>
      {description && (
        <p className="mt-2 max-w-md text-[13px] leading-relaxed text-[var(--vs-ink-3)]">
          {description}
        </p>
      )}
      {(primaryBtn || secondaryBtn) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          {primaryBtn}
          {secondaryBtn}
        </div>
      )}
    </div>
  )
}
