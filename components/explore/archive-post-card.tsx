'use client'

// 灵感广场中的「创作档案」卡片——不展示文章结果，而展示创作方法与灵感。
// 整卡点击进入 /post/[id] 查看完整档案（灵感 → AI 方向 → 版本迭代 → 最终作品）。

import Link from 'next/link'
import type { ArchiveSnapshot } from '@/lib/creative/archive'

interface ArchivePostCardProps {
  id: string
  userId: string
  authorName: string
  createdAt: string
  category: string
  tags: string[]
  likeCount: number
  commentCount: number
  saveCount: number
  archive: ArchiveSnapshot
  canDelete: boolean
  deleting: boolean
  onDelete: () => void
}

function timeAgo(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 2592000) return `${Math.floor(diff / 86400)} 天前`
  return new Date(dateStr).toLocaleDateString('zh-CN')
}

export default function ArchivePostCard({
  id,
  authorName,
  createdAt,
  category,
  tags,
  likeCount,
  commentCount,
  saveCount,
  archive,
  canDelete,
  deleting,
  onDelete,
}: ArchivePostCardProps) {
  const initial = authorName ? authorName[0].toUpperCase() : 'U'
  // 迭代次数 = 除 V1 初稿外的版本数
  const iterationCount = Math.max(0, archive.versions.length - 1)

  return (
    <Link
      href={`/post/${id}`}
      className="block bg-gradient-to-b from-indigo-950/30 to-zinc-900/60 border border-indigo-500/20 rounded-xl px-6 py-5 hover:border-indigo-500/40 transition group"
    >
      {/* 头部 */}
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-sm font-medium shrink-0">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <span className="text-sm text-zinc-300 font-medium group-hover:text-indigo-300 transition">
            {authorName || '未知用户'}
          </span>
          <span className="text-xs text-zinc-600 ml-2">{timeAgo(createdAt)}</span>
        </div>
        <span className="inline-flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-lg bg-indigo-500/15 text-indigo-300 border border-indigo-500/25 shrink-0">
          📖 创作档案
        </span>
        {canDelete && (
          <button
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onDelete()
            }}
            disabled={deleting}
            className="text-xs text-zinc-600 hover:text-red-400 disabled:opacity-40 transition"
            title="删除"
          >
            {deleting ? '删除中…' : '删除'}
          </button>
        )}
      </div>

      {/* 标题 */}
      <h3 className="text-base font-semibold text-zinc-100 mb-2 group-hover:text-indigo-200 transition">
        {archive.title}
      </h3>

      {/* 灵感：一句话 */}
      <div className="rounded-lg bg-zinc-950/40 border border-zinc-800/70 px-3.5 py-2.5 mb-3">
        <p className="text-[11px] text-zinc-500 mb-0.5">💡 灵感</p>
        <p className="text-xs text-zinc-300 leading-relaxed line-clamp-2">
          {archive.inspiration}
        </p>
      </div>

      {/* 三个档案入口 */}
      <div className="flex flex-wrap gap-2 mb-3">
        <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1">
          ✍️ 作品：<span className="text-indigo-300">查看最终内容 V{archive.finalVersionNumber}</span>
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1">
          🤖 创作过程：
          <span className="text-indigo-300">
            {iterationCount > 0 ? `${iterationCount} 次 AI 协作迭代` : '查看 AI 如何参与'}
          </span>
        </span>
      </div>

      {/* 标签 */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {tags.slice(0, 6).map((tag) => (
            <span key={tag} className="text-[10px] text-zinc-500">
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* 底部：分类 + 互动计数 */}
      <div className="flex items-center gap-4 text-[11px] text-zinc-600 pt-3 border-t border-zinc-800/60">
        <span>{category}</span>
        <span>👍 {likeCount}</span>
        <span>💬 {commentCount}</span>
        <span>⭐ {saveCount}</span>
        <span className="ml-auto text-indigo-400/70 group-hover:text-indigo-300 transition">
          查看完整创作故事 →
        </span>
      </div>
    </Link>
  )
}
