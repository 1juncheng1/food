'use client'

// 创作档案帖的内容块（不含作者行与互动条 —— 那两层由 FeedPostCard 统一渲染）。
// 档案帖展示的是"创作方法与灵感"，不是文章结果；完整叙事在 /post/[id]。

import type { ArchiveSnapshot } from '@/lib/creative/archive'

interface ArchiveBodyProps {
  archive: ArchiveSnapshot
  tags?: string[] | null
}

export default function ArchiveBody({ archive, tags }: ArchiveBodyProps) {
  const iterationCount = Math.max(0, archive.versions.length - 1)

  return (
    <>
      {/* 灵感：一句话 */}
      <div className="vs-frame px-3.5 py-2.5 mb-3">
        <p className="text-[11px] text-[var(--vs-ink-4)] mb-0.5"> 灵感</p>
        <p className="text-[13px] leading-relaxed text-[var(--vs-ink-2)] line-clamp-2">
          {archive.inspiration}
        </p>
      </div>

      {/* 两个档案入口 */}
      <div className="flex flex-wrap gap-2 mb-3">
        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--vs-ink-3)] bg-[var(--vs-void-1)] border border-[var(--vs-line)] rounded-lg px-2.5 py-1">
          ✍️ 作品：
          <span className="text-[var(--vs-ink)]">
            查看最终内容 V{archive.finalVersionNumber}
          </span>
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--vs-ink-3)] bg-[var(--vs-void-1)] border border-[var(--vs-line)] rounded-lg px-2.5 py-1">
           创作过程：
          <span className="text-[var(--vs-ink)]">
            {iterationCount > 0 ? `${iterationCount} 次 AI 协作迭代` : '查看 AI 如何参与'}
          </span>
        </span>
      </div>

      {tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.slice(0, 6).map((tag) => (
            <span key={tag} className="vs-verdict">
              #{tag}
            </span>
          ))}
        </div>
      )}
    </>
  )
}
