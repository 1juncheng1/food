'use client'

// 评论区：列表 + 输入（不做楼中楼）。
// 广场卡片内联与详情页共用；自管理加载/提交，父组件只关心评论数变化。

import { useEffect, useState } from 'react'
import { AuthorAvatar } from './author-badge'
import { deleteComment, fetchComments, submitComment } from '@/lib/community/postApi'
import type { CommunityComment } from '@/lib/community/types'
import { timeAgo } from '@/lib/community/format'

interface CommentSectionProps {
  postId: string
  token: string | null
  /** 发表成功后回调（父组件用于 +1 评论数） */
  onCommentAdded?: () => void
  /**
   * 删除成功后回调，参数为服务端最新评论数。
   * 父组件必须用它回写计数，不要自己 -1（并发下会算错）。
   */
  onCommentDeleted?: (commentCount: number) => void
  /** 当前用户昵称：服务端未回填作者名时的兜底 */
  viewerName?: string
  /** 当前用户 ID：用于判断"这条评论是不是我的"（只有自己的能删） */
  viewerId?: string
  /** false 时不自动拉取（由父组件控制挂载时机） */
  autoLoad?: boolean
}

export default function CommentSection({
  postId,
  token,
  onCommentAdded,
  onCommentDeleted,
  viewerName,
  viewerId,
  autoLoad = true,
}: CommentSectionProps) {
  const [comments, setComments] = useState<CommunityComment[]>([])
  // 初始即"加载中"（无 token 时不进入加载态），effect 内不再同步 setState
  const [loading, setLoading] = useState(autoLoad && !!token)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // 加载函数在 effect 内部定义（与 /explore 同模式），避免 effect 内同步 setState
  useEffect(() => {
    if (!autoLoad || !token) return
    async function loadComments(t: string) {
      try {
        const list = await fetchComments(t, postId)
        setComments(list)
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : '评论加载失败')
      } finally {
        setLoading(false)
      }
    }
    void loadComments(token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoad, postId])

  async function handleSubmit() {
    const content = input.trim()
    if (!content || submitting || !token) return
    setSubmitting(true)
    setError(null)
    try {
      const comment = await submitComment(token, postId, content)
      // 服务端已回填 author_name；0008 未执行时为空 → 用当前用户昵称兜底
      setComments((prev) => [
        ...prev,
        {
          ...comment,
          author_name: comment.author_name || viewerName || '我',
        },
      ])
      setInput('')
      onCommentAdded?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : '评论发送失败')
    } finally {
      setSubmitting(false)
    }
  }

  /** 删除自己的评论：乐观移除 + 失败整表回滚（计数用服务端返回值回写） */
  async function handleDelete(commentId: string) {
    if (!token || deletingId) return
    if (!confirm('确定删除这条评论吗？')) return
    const snapshot = comments
    setDeletingId(commentId)
    setError(null)
    setComments((prev) => prev.filter((c) => c.id !== commentId))
    try {
      const count = await deleteComment(token, postId, commentId)
      onCommentDeleted?.(count)
    } catch (e) {
      setComments(snapshot)
      setError(e instanceof Error ? e.message : '删除失败')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="mt-4 pt-4 border-t border-[var(--vs-line)]">
      {loading ? (
        <p className="vs-note py-2">加载评论中…</p>
      ) : comments.length === 0 ? (
        <p className="vs-note py-2">
          {error ? error : '还没有评论，来说说你的想法'}
        </p>
      ) : (
        <div className="space-y-3 mb-4">
          {comments.map((c) => (
            <div key={c.id} className="flex gap-2.5">
              <AuthorAvatar
                name={c.author_name || '创作者'}
                avatarUrl={c.author_avatar_url}
                size="sm"
              />
              <div className="min-w-0 flex-1 -mt-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--vs-ink-3)] font-medium">
                    {c.author_name || '创作者'}
                  </span>
                  <span className="vs-note">{timeAgo(c.created_at)}</span>
                  {viewerId && c.user_id === viewerId && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        void handleDelete(c.id)
                      }}
                      disabled={deletingId === c.id}
                      className="vs-link-danger disabled:opacity-40"
                    >
                      {deletingId === c.id ? '删除中…' : '删除'}
                    </button>
                  )}
                </div>
                <p className="text-[13px] text-[var(--vs-ink-2)] mt-1 leading-relaxed whitespace-pre-wrap">
                  {c.content}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && comments.length > 0 && (
        <p className="vs-error mb-2">{error}</p>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          maxLength={500}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void handleSubmit()
            }
          }}
          onClick={(e) => e.stopPropagation()}
          placeholder="写下你的评论…"
          className="vs-input vs-input-field flex-1 text-xs"
        />
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void handleSubmit()
          }}
          disabled={submitting || !input.trim() || !token}
          className="vs-btn vs-btn-primary vs-btn-sm shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? '发送中…' : '评论'}
        </button>
      </div>
    </div>
  )
}
