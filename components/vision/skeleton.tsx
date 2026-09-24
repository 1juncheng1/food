import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

/** 单个骨架块（柔和扫光，不是裸的 animate-pulse） */
export function Skeleton({
  className,
  style,
}: {
  className?: string
  style?: CSSProperties
}) {
  return <div className={cn('vs-skeleton', className)} style={style} />
}

/** 一组骨架块，用于列表加载占位 */
export function SkeletonList({
  count = 3,
  height = 88,
  gap = 12,
  className,
}: {
  count?: number
  height?: number
  gap?: number
  className?: string
}) {
  return (
    <div className={cn('flex flex-col', className)} style={{ gap }}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} style={{ height }} />
      ))}
    </div>
  )
}

/** 卡片内的文本行骨架 */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number
  className?: string
}) {
  return (
    <div className={cn('space-y-2.5', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-3"
          style={{ width: `${100 - i * 14}%` }}
        />
      ))}
    </div>
  )
}
