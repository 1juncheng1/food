'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 全站统一卡片容器。
 * - default：普通内容卡
 * - raised：稍亮，用于核心功能区
 * - ai：AI 区域（细渐变描边，克制不做霓虹）
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
        'rounded-2xl border',
        tone === 'default' && 'border-white/[0.08] bg-white/[0.03]',
        tone === 'raised' && 'border-white/[0.1] bg-white/[0.05]',
        tone === 'ai' && 'vs-ai-frame border-white/[0.08] bg-white/[0.035]',
        padded && 'px-5 py-5',
        interactive &&
          'vs-lift cursor-pointer hover:border-white/[0.16] hover:bg-white/[0.055]',
        className
      )}
    >
      {children}
    </div>
  )
}

/** 卡片内的小标题行：图标 + 文字 + 右侧补充 */
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
      {icon && <span className="text-indigo-300/80">{icon}</span>}
      <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
        {children}
      </span>
      {hint && <span className="ml-auto text-[11px] text-zinc-600">{hint}</span>}
    </div>
  )
}
