'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 全站统一面板容器。
 *
 * 视觉规则：
 * - 面与背景的差异只靠 1px 细线 + 极低的白，不靠阴影和渐变
 * - 圆角统一使用 --vs-r，全站只有一套圆角尺度
 *
 * - default：普通内容面
 * - raised：抬升一层，用于核心功能区
 * - ai：AI 区域（细冷蓝描边，克制不做霓虹）
 */
export function SurfaceCard({
  children,
  tone = 'default',
  interactive = false,
  padded = true,
  className,
  onClick,
}: {
  children: ReactNode
  tone?: 'default' | 'raised' | 'ai'
  interactive?: boolean
  padded?: boolean
  className?: string
  onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-[var(--vs-r)] border',
        tone === 'default' && 'border-[var(--vs-line)] bg-[var(--vs-surface)]',
        tone === 'raised' &&
          'border-[var(--vs-line-2)] bg-[var(--vs-void-2)]',
        tone === 'ai' &&
          'vs-ai-frame border-[var(--vs-line)] bg-[var(--vs-void-1)]',
        padded && 'px-5 py-5',
        interactive &&
          'vs-lift cursor-pointer hover:border-[var(--vs-border-hover)] hover:bg-[var(--vs-surface-hover)]',
        className
      )}
    >
      {children}
    </div>
  )
}

/** 面板内的小标题行：标签 + 右侧补充 */
export function CardLabel({
  icon,
  children,
  hint,
  className,
}: {
  icon?: ReactNode
  children: ReactNode
  hint?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      {icon && (
        <span className="text-[var(--vs-beam-text)] opacity-70">{icon}</span>
      )}
      <span className="vs-mark">{children}</span>
      {hint && (
        <span className="ml-auto text-[11px] text-[var(--vs-ink-5)]">
          {hint}
        </span>
      )}
    </div>
  )
}
