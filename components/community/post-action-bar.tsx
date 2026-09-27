'use client'

// 帖子互动条：点赞 / 评论 / 收藏 / 分享（复制链接）
// 纯展示 + 回调：不做请求、不做乐观更新，状态由父组件持有并校正。

import { useState } from 'react'

interface PostActionBarProps {
  liked: boolean
  saved: boolean
  likeCount: number
  commentCount: number
  saveCount: number
  busyLike?: boolean
  busySave?: boolean
  onToggleLike: () => void
  onToggleSave: () => void
  onToggleComments?: () => void
  commentsOpen?: boolean
  /** 分享链接（默认取当前域名 /post/[id]，由父组件传入 postId） */
  postId?: string
  compact?: boolean
}

export default function PostActionBar({
  liked,
  saved,
  likeCount,
  commentCount,
  saveCount,
  busyLike = false,
  busySave = false,
  onToggleLike,
  onToggleSave,
  onToggleComments,
  commentsOpen = false,
  postId,
  compact = false,
}: PostActionBarProps) {
  const [copied, setCopied] = useState(false)

  async function handleShare() {
    if (!postId || typeof window === 'undefined') return
    const url = `${window.location.origin}/post/${postId}`
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
      } else {
        // 兜底：非安全上下文（http）没有 clipboard API
        const ta = document.createElement('textarea')
        ta.value = url
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // 复制失败不阻断：用户仍可手动复制地址栏
      setCopied(false)
    }
  }

  const base = compact ? 'text-[11px]' : 'text-xs'
  const gap = compact ? 'gap-4' : 'gap-6'

  return (
    <div className={`flex items-center ${gap} ${base}`}>
      {/* 点赞 */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onToggleLike()
        }}
        disabled={busyLike}
        aria-pressed={liked}
        aria-label={liked ? '取消点赞' : '点赞'}
        className={`flex items-center gap-1.5 transition disabled:opacity-40 disabled:cursor-not-allowed ${
          liked ? 'text-[var(--vs-ink)]' : 'text-[var(--vs-ink-4)] hover:text-[var(--vs-ink-2)]'
        }`}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill={liked ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
        {likeCount}
      </button>

      {/* 评论 */}
      {onToggleComments && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onToggleComments()
          }}
          aria-label="评论"
          className={`flex items-center gap-1.5 transition ${
            commentsOpen ? 'text-[var(--vs-ink)]' : 'text-[var(--vs-ink-4)] hover:text-[var(--vs-ink)]'
          }`}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          {commentCount}
        </button>
      )}

      {/* 收藏 */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onToggleSave()
        }}
        disabled={busySave}
        aria-pressed={saved}
        aria-label={saved ? '取消收藏' : '收藏'}
        className={`flex items-center gap-1.5 transition disabled:opacity-40 disabled:cursor-not-allowed ${
          saved ? 'text-[var(--vs-ink)]' : 'text-[var(--vs-ink-4)] hover:text-[var(--vs-ink-2)]'
        }`}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill={saved ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
        {saveCount}
      </button>

      {/* 分享：复制链接 */}
      {postId && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void handleShare()
          }}
          aria-label="复制链接"
          className={`flex items-center gap-1.5 transition ${
            copied ? 'text-[var(--vs-ink)]' : 'text-[var(--vs-ink-4)] hover:text-[var(--vs-ink-2)]'
          }`}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
            <path d="M16 6l-4-4-4 4" />
            <path d="M12 2v13" />
          </svg>
          {copied ? '已复制' : '分享'}
        </button>
      )}
    </div>
  )
}
