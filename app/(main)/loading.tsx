import { PageShell, Skeleton, SkeletonList } from '@/components/vision'

// ────────────────────────────────────────────────────────────
// (main) 路由组导航加载态
//
// 为什么 (main) 要单独有一份：根 app/loading.tsx 不在 (main) 的
// Suspense 边界上，切换 (main) 内页面时它不会出现，表现就是点了导航
// 之后旧页面原地"卡一下"才跳——用户感知到的延迟多半来自这段空档。
//
// 这里沿用真实页面的排版（页头 + 沉淀条 + 卡片列表），
// 让切换看起来是"内容正在成形"，而不是"页面没反应"。
// ────────────────────────────────────────────────────────────

export default function Loading() {
  return (
    <PageShell>
      {/* 页头骨架 */}
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-3 w-80" />
      </div>

      {/* 沉淀条骨架 */}
      <div className="mt-9 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} style={{ height: 52 }} />
        ))}
      </div>

      {/* 内容区骨架 */}
      <SkeletonList className="mt-9" count={3} height={148} />
    </PageShell>
  )
}
