import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 全站页面外壳：统一最大宽度、左右留白、上下呼吸感。
 * 所有功能页都套一层，保证"大留白 + 居中内容"的一致性。
 */
export function PageShell({
  children,
  width = 'default',
  className,
}: {
  children: ReactNode
  width?: 'default' | 'wide' | 'narrow'
  className?: string
}) {
  return (
    <div
      className={cn(
        'mx-auto w-full px-5 sm:px-8 lg:px-10 pt-8 sm:pt-10 pb-24 sm:pb-28',
        width === 'wide' && 'max-w-[1240px]',
        width === 'default' && 'max-w-[1120px]',
        width === 'narrow' && 'max-w-[860px]',
        className
      )}
    >
      {children}
    </div>
  )
}

/** 内容区块之间的统一间距 */
export function PageGap({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <div
      className={cn(
        size === 'sm' && 'h-5',
        size === 'md' && 'h-8',
        size === 'lg' && 'h-12'
      )}
    />
  )
}
