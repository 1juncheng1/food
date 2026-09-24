import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type ChipTone =
  | 'neutral'
  | 'brand'
  | 'accent'
  | 'warm'
  | 'violet'
  | 'muted'

const TONE_CLASS: Record<ChipTone, string> = {
  neutral: 'bg-white/[0.06] text-zinc-300 border-white/[0.09]',
  brand: 'bg-indigo-500/[0.14] text-indigo-300 border-indigo-500/25',
  accent: 'bg-emerald-500/[0.14] text-emerald-300 border-emerald-500/25',
  warm: 'bg-amber-500/[0.14] text-amber-300 border-amber-500/25',
  violet: 'bg-violet-500/[0.14] text-violet-300 border-violet-500/25',
  muted: 'bg-transparent text-zinc-500 border-white/[0.07]',
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
        'inline-flex items-center gap-1 rounded-full border font-medium',
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
