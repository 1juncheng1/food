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
        'vs-error flex flex-col items-start gap-3',
        compact ? 'px-4 py-3.5' : 'px-5 py-5',
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 vs-error-text" />
        <div className="min-w-0">
          <p className="text-[14px] font-medium">{title}</p>
          {message && (
            <p className="vs-note mt-1 leading-relaxed">
              {message}
            </p>
          )}
        </div>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="vs-btn vs-btn-ghost vs-btn-sm vs-error-text"
        >
          <RefreshCw size={13} />
          {retryLabel}
        </button>
      )}
    </div>
  )
}
