'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import ArchivePostCard from '@/components/explore/archive-post-card'
import type { ArchiveSnapshot } from '@/lib/creative/archive'

// ────────────────────────────────────────────────────────────
// 灵感广场：展示所有用户发布的公开灵感，按时间倒序
// 支持点赞、收藏、评论互动
// ────────────────────────────────────────────────────────────

/** 帖子数据结构（与 RPC 返回字段对应） */
interface Post {
  id: string
  user_id: string
  content: string
  content_type: string
  category: string
  tags: string[]
  like_count: number
  comment_count: number
  save_count: number
  is_public: boolean
  created_at: string
  author_name: string
  current_user_liked: boolean
  current_user_saved: boolean
  image_url: string | null
  // 创作档案帖（post_type=archive 时 archive 为发布时的只读快照）
  post_type: string | null
  archive: ArchiveSnapshot | null
  source_project_id: string | null
}

/** 评论数据结构 */
interface Comment {
  id: string
  post_id: string
  user_id: string
  content: string
  created_at: string
  author_name: string
}

/** 格式化时间为相对时间（如"3 分钟前"） */
function timeAgo(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000)

  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 2592000) return `${Math.floor(diff / 86400)} 天前`
  return date.toLocaleDateString('zh-CN')
}

/** 取内容摘要（前 200 字，去除 [图片描述] 标记） */
function getContentSummary(content: string): string {
  const cleanContent = content.replace(/\n\n\[图片描述\][\s\S]*$/, '')
  const text = cleanContent || content
  return text.length > 200 ? text.slice(0, 200) + '…' : text
}

/** 从内容中提取图片描述段 */
function getImageDescription(content: string): string | null {
  const match = content.match(/\[图片描述\]\s*([\s\S]+)$/)
  return match ? match[1].trim() : null
}

export default function ExplorePage() {
  const router = useRouter()
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 展开评论的帖子 ID
  const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set())
  // 评论数据缓存：postId → comments
  const [commentsByPost, setCommentsByPost] = useState<Record<string, Comment[]>>({})
  // 评论加载中状态
  const [commentsLoading, setCommentsLoading] = useState<Set<string>>(new Set())
  // 评论输入内容
  const [commentInputs, setCommentInputs] = useState<Record<string, string>>({})
  // 评论提交中状态
  const [commentSubmitting, setCommentSubmitting] = useState<Set<string>>(new Set())
  // 互动操作中状态（防止重复提交）
  const [interactionBusy, setInteractionBusy] = useState<Set<string>>(new Set())
  // 当前用户 token（缓存在 state 中避免反复 getSession）
  const [accessToken, setAccessToken] = useState<string | null>(null)
  // 用户是否有风格向量（决定标题显示"为你推荐"还是"最新发布"）
  const [hasStyleVector, setHasStyleVector] = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  /** 加载帖子列表 */
  const loadPosts = useCallback(async (token: string) => {
    try {
      const res = await fetch('/api/posts', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.error ?? `加载失败（${res.status}）`)
        return
      }
      const data = await res.json()
      setPosts(data.posts ?? [])
      setHasStyleVector(!!data.hasStyleVector)
      setError(null)
    } catch {
      setError('网络异常，请稍后重试')
    }
  }, [])

  /** 下拉刷新：重新加载 */
  async function handleRefresh() {
    if (refreshing || !accessToken) return
    setRefreshing(true)
    await loadPosts(accessToken)
    setRefreshing(false)
  }

  /** 点赞/收藏 toggle（乐观更新，fire-and-forget 模式提速） */
  async function handleInteraction(
    postId: string,
    type: 'like' | 'save'
  ) {
    if (!accessToken) return
    const key = `${postId}:${type}`
    if (interactionBusy.has(key)) return

    // 乐观更新：立即更新 UI，不等网络返回
    const togglePost = (p: Post, revert = false): Post => {
      const isOn = type === 'like' ? p.current_user_liked : p.current_user_saved
      const newIsOn = revert ? isOn : !isOn
      if (type === 'like') {
        return { ...p, current_user_liked: newIsOn, like_count: p.like_count + (newIsOn ? 1 : -1) }
      }
      return { ...p, current_user_saved: newIsOn, save_count: p.save_count + (newIsOn ? 1 : -1) }
    }

    setPosts((prev) => prev.map((p) => (p.id === postId ? togglePost(p) : p)))

    // fire-and-forget：发请求但不阻塞 UI
    // 用 AbortController 实现快速超时，失败时静默回退
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    try {
      const res = await fetch(`/api/posts/${postId}/interactions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ interactionType: type }),
        signal: controller.signal,
      })
      if (!res.ok) {
        // 失败回退
        setPosts((prev) => prev.map((p) => (p.id === postId ? togglePost(p, true) : p)))
      }
    } catch {
      // 网络失败：回退
      setPosts((prev) => prev.map((p) => (p.id === postId ? togglePost(p, true) : p)))
    } finally {
      clearTimeout(timeout)
      setInteractionBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  /** 切换评论展开/折叠 */
  async function toggleComments(postId: string) {
    const isExpanded = expandedComments.has(postId)
    if (isExpanded) {
      // 折叠
      setExpandedComments((prev) => {
        const next = new Set(prev)
        next.delete(postId)
        return next
      })
    } else {
      // 展开 + 加载评论
      setExpandedComments((prev) => new Set(prev).add(postId))
      if (!commentsByPost[postId] && accessToken) {
        setCommentsLoading((prev) => new Set(prev).add(postId))
        try {
          const res = await fetch(`/api/posts/${postId}/comments`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
          if (res.ok) {
            const data = await res.json()
            setCommentsByPost((prev) => ({
              ...prev,
              [postId]: data.comments ?? [],
            }))
          }
        } catch {
          // 静默失败，评论区显示空
        } finally {
          setCommentsLoading((prev) => {
            const next = new Set(prev)
            next.delete(postId)
            return next
          })
        }
      }
    }
  }

  /** 提交评论 */
  async function handleSubmitComment(postId: string) {
    if (!accessToken) return
    if (commentSubmitting.has(postId)) return
    const content = (commentInputs[postId] ?? '').trim()
    if (!content) return

    setCommentSubmitting((prev) => new Set(prev).add(postId))
    try {
      const res = await fetch(`/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.error ?? '评论失败')
        return
      }
      const data = await res.json()
      // 添加到评论列表
      setCommentsByPost((prev) => ({
        ...prev,
        [postId]: [...(prev[postId] ?? []), data.comment],
      }))
      // 清空输入框
      setCommentInputs((prev) => ({ ...prev, [postId]: '' }))
      // 更新评论计数
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId
            ? { ...p, comment_count: p.comment_count + 1 }
            : p
        )
      )
      setError(null)
    } catch {
      setError('网络异常，请稍后重试')
    } finally {
      setCommentSubmitting((prev) => {
        const next = new Set(prev)
        next.delete(postId)
        return next
      })
    }
  }

  /** 删除帖子 */
  async function handleDeletePost(postId: string) {
    if (!accessToken || deletingId) return
    if (!confirm('确定删除这条灵感吗？')) return

    setDeletingId(postId)
    // 乐观删除：立即从列表移除
    setPosts((prev) => prev.filter((p) => p.id !== postId))

    try {
      const res = await fetch(`/api/posts/${postId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) {
        // 删除失败：重新加载列表恢复数据
        setError('删除失败，已恢复')
        await loadPosts(accessToken)
      }
    } catch {
      setError('网络异常，删除失败')
      await loadPosts(accessToken)
    } finally {
      setDeletingId(null)
    }
  }

  useEffect(() => {
    async function init() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.replace('/login')
        return
      }
      setAccessToken(session.access_token)
      setCurrentUserId(session.user.id)
      setLoading(true)
      await loadPosts(session.access_token)
      setLoading(false)
    }
    init()
  }, [router, loadPosts])

  return (
    <div className="inner-page gen-stage" data-mode="inspiration">
      <div className="inner-container">
        {/* ── 顶部 ── */}
        <div className="inner-header">
          <div>
            <h1 className="inner-header-title">
              {hasStyleVector ? '为你推荐' : '灵感广场'}
            </h1>
            <p className="inner-header-sub">
              {hasStyleVector
                ? '基于你的创作风格，为你匹配相似内容'
                : '发现其他创作者的精彩内容'}
            </p>
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-40 transition flex items-center gap-1.5"
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
              className={refreshing ? 'animate-spin' : ''}
            >
              <path d="M21 2v6h-6" />
              <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 8" />
              <path d="M3 22v-6h6" />
              <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6-2.3L3 16" />
            </svg>
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>

        {/* ── 错误提示 ── */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-5 py-4 mb-6">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* ── 加载中 ── */}
        {loading && (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-5 animate-pulse"
                style={{ height: 120 }}
              />
            ))}
          </div>
        )}

        {/* ── 空状态 ── */}
        {!loading && posts.length === 0 && !error && (
          <div className="inner-empty">
            <p>广场上还没有内容</p>
            <p className="sub">成为第一个发布灵感的人</p>
          </div>
        )}

        {/* ── 帖子列表 ── */}
        {!loading && posts.length > 0 && (
          <div className="space-y-4">
            {posts.map((post) => {
              // ── 创作档案帖：走专用创作卡片，点击进详情页 ──
              if (post.post_type === 'archive' && post.archive) {
                return (
                  <ArchivePostCard
                    key={post.id}
                    id={post.id}
                    userId={post.user_id}
                    authorName={post.author_name}
                    createdAt={post.created_at}
                    category={post.category}
                    tags={post.tags ?? []}
                    likeCount={post.like_count}
                    commentCount={post.comment_count}
                    saveCount={post.save_count}
                    archive={post.archive}
                    canDelete={currentUserId === post.user_id}
                    deleting={deletingId === post.id}
                    onDelete={() => handleDeletePost(post.id)}
                  />
                )
              }

              const summary = getContentSummary(post.content)
              const imgDesc = post.content_type === 'image' ? getImageDescription(post.content) : null
              const initial = post.author_name
                ? post.author_name[0].toUpperCase()
                : 'U'
              const isExpanded = expandedComments.has(post.id)
              const postComments = commentsByPost[post.id] ?? []
              const commentsAreLoading = commentsLoading.has(post.id)
              const commentInput = commentInputs[post.id] ?? ''
              const isSubmittingComment = commentSubmitting.has(post.id)

              return (
                <div
                  key={post.id}
                  className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-5 hover:border-zinc-700 transition"
                >
                  {/* ── 卡片头部：作者 + 时间 ── */}
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-sm font-medium shrink-0">
                      {initial}
                    </div>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/profile/${post.user_id}`}
                        className="text-sm text-zinc-300 font-medium hover:text-indigo-400 transition"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {post.author_name || '未知用户'}
                      </Link>
                      <span className="text-xs text-zinc-600 ml-2">
                        {timeAgo(post.created_at)}
                      </span>
                    </div>
                    <span className="text-xs px-2.5 py-1 rounded-lg bg-zinc-800 text-zinc-400 shrink-0">
                      {post.category}
                    </span>
                    {/* 删除按钮（仅自己的帖子显示） */}
                    {currentUserId === post.user_id && (
                      <button
                        onClick={() => handleDeletePost(post.id)}
                        disabled={deletingId === post.id}
                        className="ml-auto text-xs text-zinc-600 hover:text-red-400 disabled:opacity-40 transition"
                        title="删除"
                      >
                        {deletingId === post.id ? '删除中…' : '删除'}
                      </button>
                    )}
                  </div>

                  {/* ── 内容摘要 ── */}
                  <p className="text-sm text-zinc-300 leading-relaxed mb-4">
                    {summary}
                  </p>

                  {/* ── 图片缩略图 ── */}
                  {post.image_url && (
                    <div className="mb-4">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={post.image_url}
                        alt="帖子图片"
                        className="w-full max-h-80 object-cover rounded-xl border border-zinc-800"
                      />
                    </div>
                  )}

                  {/* ── 图片描述（图片帖显示标记）── */}
                  {imgDesc && (
                    <div className="bg-zinc-800/40 border border-zinc-700/50 rounded-lg px-4 py-3 mb-4">
                      <p className="text-xs text-zinc-500 mb-1">📷 图片描述</p>
                      <p className="text-xs text-zinc-400 leading-relaxed line-clamp-2">
                        {imgDesc.slice(0, 100)}{imgDesc.length > 100 ? '…' : ''}
                      </p>
                    </div>
                  )}

                  {/* ── 标签 ── */}
                  {post.tags && post.tags.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-4">
                      {post.tags.map((tag, i) => (
                        <span
                          key={i}
                          className="text-xs px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* ── 互动按钮 ── */}
                  <div className="flex items-center gap-6 pt-1">
                    {/* 点赞 */}
                    <button
                      onClick={() => handleInteraction(post.id, 'like')}
                      disabled={interactionBusy.has(`${post.id}:like`)}
                      className={`flex items-center gap-1.5 text-xs transition disabled:opacity-40 disabled:cursor-not-allowed ${
                        post.current_user_liked
                          ? 'text-red-400'
                          : 'text-zinc-500 hover:text-red-400'
                      }`}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill={post.current_user_liked ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                      </svg>
                      {post.like_count}
                    </button>

                    {/* 评论 */}
                    <button
                      onClick={() => toggleComments(post.id)}
                      className={`flex items-center gap-1.5 text-xs transition ${
                        isExpanded
                          ? 'text-indigo-400'
                          : 'text-zinc-500 hover:text-indigo-400'
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
                      {post.comment_count}
                    </button>

                    {/* 收藏 */}
                    <button
                      onClick={() => handleInteraction(post.id, 'save')}
                      disabled={interactionBusy.has(`${post.id}:save`)}
                      className={`flex items-center gap-1.5 text-xs transition disabled:opacity-40 disabled:cursor-not-allowed ${
                        post.current_user_saved
                          ? 'text-amber-400'
                          : 'text-zinc-500 hover:text-amber-400'
                      }`}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill={post.current_user_saved ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                      </svg>
                      {post.save_count}
                    </button>
                  </div>

                  {/* ── 评论区（展开时显示）── */}
                  {isExpanded && (
                    <div className="mt-4 pt-4 border-t border-zinc-800">
                      {/* 已有评论列表 */}
                      {commentsAreLoading ? (
                        <p className="text-xs text-zinc-600 py-2">加载评论中…</p>
                      ) : postComments.length === 0 ? (
                        <p className="text-xs text-zinc-600 py-2">还没有评论，来评论一下吧</p>
                      ) : (
                        <div className="space-y-3 mb-4">
                          {postComments.map((comment) => (
                            <div key={comment.id} className="flex gap-2.5">
                              <div className="w-6 h-6 rounded-full bg-zinc-700 text-zinc-300 flex items-center justify-center text-[10px] font-medium shrink-0">
                                {comment.author_name
                                  ? comment.author_name[0].toUpperCase()
                                  : 'U'}
                              </div>
                              <div className="min-w-0 flex-1">
                                <span className="text-xs text-zinc-400 font-medium">
                                  {comment.author_name || '未知用户'}
                                </span>
                                <span className="text-xs text-zinc-600 ml-2">
                                  {timeAgo(comment.created_at)}
                                </span>
                                <p className="text-xs text-zinc-300 mt-1 leading-relaxed">
                                  {comment.content}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* 评论输入框 */}
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={commentInput}
                          onChange={(e) =>
                            setCommentInputs((prev) => ({
                              ...prev,
                              [post.id]: e.target.value,
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              handleSubmitComment(post.id)
                            }
                          }}
                          placeholder="写下你的评论…"
                          className="flex-1 bg-zinc-800/60 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500 transition"
                        />
                        <button
                          onClick={() => handleSubmitComment(post.id)}
                          disabled={isSubmittingComment || !commentInput.trim()}
                          className="px-4 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition shrink-0"
                        >
                          {isSubmittingComment ? '发送中…' : '评论'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
