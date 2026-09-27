import { cn } from '@/lib/utils'

/**
 * 页面顶部的数据沉淀条：让用户看到"积累"本身。
 *
 * 不用卡片墙：数字本身就是视觉，用细线分栏承载，
 * 数字一律等宽（tabular-nums），这是精密感的来源。
 */
export function StatRow({
  items,
  className,
}: {
  items: { label: string; value: string | number; hint?: string }[]
  className?: string
}) {
  return (
    <dl
      className={cn(
        'grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4',
        className
      )}
    >
      {items.map((it) => (
        <div
          key={it.label}
          className="border-l border-[var(--vs-line)] pl-4"
        >
          <dt className="vs-mark mb-1.5">{it.label}</dt>
          <dd className="vs-num text-[22px] leading-none text-[var(--vs-ink)]">
            {it.value}
          </dd>
          {it.hint && (
            <p className="mt-1.5 text-[11px] text-[var(--vs-ink-5)]">
              {it.hint}
            </p>
          )}
        </div>
      ))}
    </dl>
  )
}
