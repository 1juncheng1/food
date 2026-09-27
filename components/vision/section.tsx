import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 页面内的二级区块。
 *
 * 统一"标题 + 一句说明 + 右侧操作 + 内容"的结构，让所有页面同频。
 * 眉标是稀缺资源：没有真实分类信息就不要传 eyebrow。
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
            {eyebrow && <p className="vs-mark mb-2">{eyebrow}</p>}
            {title && <h2 className="vs-h3">{title}</h2>}
            {description && (
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--vs-ink-3)]">
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
