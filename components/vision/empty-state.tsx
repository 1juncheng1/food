'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 全站统一空状态。
 * 原则：空状态不是"没有东西"，而是"下一步该做什么"的引导。
 * 文案必须告诉用户：开始之后 AI 会因此变得更懂你。
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
        <Link
          href={actionHref}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500"
        >
          {actionLabel}
        </Link>
      ) : (
        <button
          onClick={onAction}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500"
        >
          {actionLabel}
        </button>
      )
    ) : null

  const secondaryBtn =
    secondaryLabel && (secondaryHref || onSecondary) ? (
      secondaryHref ? (
        <Link
          href={secondaryHref}
          className="inline-flex items-center gap-2 rounded-xl border border-white/[0.1] px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-white/20 hover:text-white"
        >
          {secondaryLabel}
        </Link>
      ) : (
        <button
          onClick={onSecondary}
          className="inline-flex items-center gap-2 rounded-xl border border-white/[0.1] px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-white/20 hover:text-white"
        >
          {secondaryLabel}
        </button>
      )
    ) : null

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.09] bg-white/[0.015] text-center',
        compact ? 'px-6 py-8' : 'px-6 py-14',
        className
      )}
    >
      {icon && (
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-zinc-500">
          {icon}
        </div>
      )}
      <p className="text-[15px] font-medium text-zinc-200">{title}</p>
      {description && (
        <p className="mt-2 max-w-md text-[13px] leading-relaxed text-zinc-500">
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
