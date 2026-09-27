import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 全站统一的页面页眉。
 *
 * 结构：眉标（可选） → 标题 → 一句产品理念 → 右侧动作 / AI 状态
 *
 * 排版纪律：标题与说明竖向堆叠，不做"左大标题 + 右小段落"的漂浮排版；
 * 眉标不是每个页面都要有，没有就不传。
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  ai,
  className,
}: {
  eyebrow?: string
  title: string
  description?: string
  actions?: ReactNode
  /** AI 状态槽位：放 <AiStatus />，让系统状态始终可见 */
  ai?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('mb-8 sm:mb-10', className)}>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 max-w-2xl">
          {eyebrow && <p className="vs-mark mb-3">{eyebrow}</p>}
          <h1 className="vs-h1">{title}</h1>
          {description && <p className="vs-body mt-3">{description}</p>}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2.5">{actions}</div>
        )}
      </div>
      {ai && <div className="mt-5">{ai}</div>}
    </header>
  )
}
