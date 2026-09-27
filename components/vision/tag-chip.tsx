import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type ChipTone =
  | 'neutral'
  | 'brand'
  | 'accent'
  | 'warm'
  | 'avoid'
  | 'violet'
  | 'muted'

/**
 * 全站统一标签。
 *
 * 色彩纪律：只有 brand（冷蓝微光）是强调色；
 * accent / warm 只用于真实语义状态（成功 / 需要注意）；
 * violet 兼容旧调用，视觉并入 brand，不再单独存在紫色。
 */
const TONE_CLASS: Record<ChipTone, string> = {
  neutral:
    'bg-[var(--vs-surface)] text-[var(--vs-ink-2)] border-[var(--vs-line-2)]',
  brand:
    'bg-[var(--vs-beam-wash)] text-[var(--vs-beam-text)] border-[var(--vs-beam-line)]',
  /** accent 不再用绿色：通用标签里的"正面"语义太弱，改用亮度层级区分 */
  accent: 'bg-[var(--vs-surface-hover)] text-[var(--vs-ink)] border-[var(--vs-line-2)]',
  warm: 'bg-[var(--vs-warn-wash)] text-[var(--vs-warn)] border-[var(--vs-warn-line)]',
  /** 硬禁忌（排斥元素）：全站唯一的红色用法 */
  avoid:
    'bg-[var(--vs-danger-wash)] text-[var(--vs-danger)] border-[var(--vs-danger-line)]',
  violet:
    'bg-[var(--vs-beam-wash)] text-[var(--vs-beam-text)] border-[var(--vs-beam-line)]',
  muted: 'bg-transparent text-[var(--vs-ink-4)] border-[var(--vs-line)]',
}

/** 全站统一标签/徽章 */
export function TagChip({
  children,
  tone = 'neutral',
  icon,
  className,
  size = 'md',
}: {
  children: ReactNode
  tone?: ChipTone
  icon?: ReactNode
  className?: string
  size?: 'sm' | 'md'
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--vs-r-sm)] border font-medium',
        size === 'sm' ? 'px-2 py-[1px] text-[11px]' : 'px-2.5 py-0.5 text-xs',
        TONE_CLASS[tone],
        className
      )}
    >
      {icon}
      {children}
    </span>
  )
}
