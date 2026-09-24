'use client'

import { AlertTriangle, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 全站统一错误状态：说明发生了什么 + 给出重试出口，绝不静默失败。
 */
export function ErrorState({
  title = '这部分内容没能加载出来',
  message,
  onRetry,
  retryLabel = '重试',
  className,
  compact = false,
}: {
  title?: string
  message?: string
  onRetry?: () => void
  retryLabel?: string
  className?: string
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-3 rounded-2xl border border-red-500/25 bg-red-500/[0.06]',
        compact ? 'px-4 py-3.5' : 'px-5 py-5',
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-400" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-red-200">{title}</p>
          {message && (
            <p className="mt-1 text-[13px] leading-relaxed text-red-300/70">
              {message}
            </p>
          )}
        </div>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-[13px] font-medium text-red-200 transition hover:border-red-500/50 hover:bg-red-500/10"
        >
          <RefreshCw size={13} />
          {retryLabel}
        </button>
      )}
    </div>
  )
}
