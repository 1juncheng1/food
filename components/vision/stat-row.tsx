import { cn } from '@/lib/utils'

/** 页面顶部的数据沉淀条：让用户看到"积累"本身 */
export function StatRow({
  items,
  className,
}: {
  items: { label: string; value: string | number; hint?: string }[]
  className?: string
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-3 sm:grid-cols-4',
        className
      )}
    >
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3.5 py-3"
        >
          <p className="text-xl font-semibold tracking-tight text-white">
            {it.value}
          </p>
          <p className="mt-0.5 text-[12px] text-zinc-500">{it.label}</p>
          {it.hint && (
            <p className="mt-0.5 text-[11px] text-zinc-600">{it.hint}</p>
          )}
        </div>
      ))}
    </div>
  )
}
