import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 全站统一的页面页眉。
 *
 * 结构（对应产品原则「三、页面统一结构」的顶部）：
 *   eyebrow（短标签） → 标题 → 一句产品理念描述 → 右侧动作 / AI 状态
 *
 * 每个功能页都必须有 description：告诉用户「这个页面为什么存在、AI 在这里做什么」。
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
  /** AI 状态槽位：放 <AiStatus />，让「AI 正在工作」始终可见 */
  ai?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('mb-8 sm:mb-10', className)}>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 max-w-2xl">
          {eyebrow && (
            <p className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-300/80">
              {eyebrow}
            </p>
          )}
          <h1 className="text-[26px] sm:text-[32px] font-semibold leading-tight tracking-tight text-white">
            {title}
          </h1>
          {description && (
            <p className="mt-3 text-sm sm:text-[15px] leading-relaxed text-zinc-400">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2.5">{actions}</div>
        )}
      </div>
      {ai && <div className="mt-5">{ai}</div>}
    </header>
  )
}
