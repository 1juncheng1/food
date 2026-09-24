import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 页面内的二级区块。统一"标题 + 一句说明 + 右侧操作 + 内容"的结构，
 * 让所有页面呈现相同的节奏感，而不是各自堆 div。
 */
export function Section({
  title,
  description,
  eyebrow,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  title?: string
  description?: string
  eyebrow?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  id?: string
}) {
  return (
    <section id={id} className={cn('scroll-mt-8', className)}>
      {(title || actions || eyebrow) && (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            {eyebrow && (
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                {eyebrow}
              </p>
            )}
            {title && (
              <h2 className="text-[17px] sm:text-lg font-semibold tracking-tight text-zinc-100">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-500">
                {description}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  )
}
