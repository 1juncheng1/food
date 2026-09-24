'use client'

// ────────────────────────────────────────────────────────────
// 灵感广场：创作者社区 Feed
//
// 相比旧版修掉的问题：
//   1. 点赞/收藏防重复锁从未 add（只在 finally 里 delete）→ 连点发多个 toggle
//   2. 失败回退用的是「已乐观更新后的对象」，等于没回退，且计数再错一次
//   3. 丢弃服务端返回的最新计数 → 本地 ±1 与 DB 长期漂移（"刷新就消失"）
//   4. 卡片不可点进详情、作者名显示为邮箱前缀、无整卡标题/标签
//   5. 从详情返回时重新从第一页加载、滚动位置归零
// ────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { RefreshCw } from 'lucide-react'
import { getValidSession } from '@/lib/supabaseClient'
import {
  AiStatus,
  EmptyState,
  ErrorState,
  PageHeader,
  PageShell,
  SkeletonList,
} from '@/components/vision'
import FeedPostCard from '@/components/community/feed-post-card'
import { toggleInteraction } from '@/lib/community/postApi'
import { fetchAuthorCards, type AuthorCard } from '@/lib/community/authorCard'
import type { CommunityPost } from '@/lib/community/types'

const PAGE_SIZE = 20
/** 返回广场时恢复滚动与已加载条数（tab 级，刷新即清空） */
const VIEW_STATE_KEY = 'explore:view-state'

type ViewState = { y: number; count: number }

export default function ExplorePage() {
  const router = useRouter()
  const [posts, setPosts] = useState<CommunityPost[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [viewerName, setViewerName] = useState<string>('')
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [hasStyleVector, setHasStyleVector] = useState(false)
  const [authorCards, setAuthorCards] = useState<Record<string, AuthorCard>>({})

  // ── ref 镜像：供 observer / 回调闭包读取最新值，避免 effect 频繁重建 ──
  const postsRef = useRef<CommunityPost[]>([])
  const busyRef = useRef<Set<string>>(new Set())
  const tokenRef = useRef<string | null>(null)
  const offsetRef = useRef(0)
  const hasMoreRef = useRef(true)
  const loadingMoreRef = useRef(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const restoredRef = useRef(false)

  useEffect(() => {
    postsRef.current = posts
  }, [posts])

  useEffect(() => {
    tokenRef.current = accessToken
  }, [accessToken])

  // ── 加载一页 ──
  const loadPosts = useCallback(
    async (
      token: string,
      opts: { append?: boolean; limit?: number; restore?: ViewState | null } = {}
    ) => {
      const append = opts.append === true
      if (append && (loadingMoreRef.current || !hasMoreRef.current)) return

      const limit = opts.limit ?? PAGE_SIZE
      const offset = append ? offsetRef.current : 0
      if (append) {
        loadingMoreRef.current = true
        setLoadingMore(true)
      }

      const controller = new AbortController()
      abortRef.current = controller
      try {
        const params = new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
        })
        const res = await fetch(`/api/posts?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null
          setError(data?.error ?? `加载失败（${res.status}）`)
          return
        }
        const data = (await res.json()) as {
          posts?: CommunityPost[]
          hasStyleVector?: boolean
          viewerId?: string
        }
        const newPosts = data.posts ?? []

        setPosts((prev) => {
          // 去重：offset 分页遇到新帖插入会错位，同 id 不重复入列
          if (!append) return newPosts
          const seen = new Set(prev.map((p) => p.id))
          return [...prev, ...newPosts.filter((p) => !seen.has(p.id))]
        })
        setHasStyleVector(!!data.hasStyleVector)
        if (data.viewerId) setViewerId(data.viewerId)
        setError(null)

        offsetRef.current = offset + newPosts.length
        const reachedEnd = newPosts.length < limit
        hasMoreRef.current = !reachedEnd
        setHasMore(!reachedEnd)

        // 返回广场时的滚动恢复：等 DOM 渲染完再定位
        const restore = opts.restore
        if (restore && !restoredRef.current) {
          restoredRef.current = true
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              window.scrollTo(0, restore.y)
            })
          })
        }
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        setError('网络异常，请稍后重试')
      } finally {
        if (append) {
          loadingMoreRef.current = false
          setLoadingMore(false)
        }
      }
    },
    []
  )

  // ── 初始化 ──
  useEffect(() => {
    async function init() {
      // 必须走 getValidSession：裸 getSession() 不刷新 token，久留后拿到过期 token 直接 401
      const session = await getValidSession()
      if (!session) {
        router.replace('/login')
        return
      }
      const metaName = session.user.user_metadata?.display_name
      const emailPrefix = session.user.email?.split('@')[0] ?? ''
      setAccessToken(session.access_token)
      setViewerId(session.user.id)
      setViewerName(
        typeof metaName === 'string' && metaName.trim() ? metaName.trim() : emailPrefix
      )

      // 从详情页返回：一次性拉回上次已加载的条数并恢复滚动
      let restore: ViewState | null = null
      try {
        const raw = sessionStorage.getItem(VIEW_STATE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw) as ViewState
          if (typeof parsed?.y === 'number' && parsed.count > 0) {
            restore = { y: parsed.y, count: Math.min(parsed.count, 200) }
          }
          sessionStorage.removeItem(VIEW_STATE_KEY)
        }
      } catch {
        // sessionStorage 不可用（隐私模式）：忽略，按首屏加载
      }

      setLoading(true)
      await loadPosts(session.access_token, {
        limit: restore ? Math.max(PAGE_SIZE, restore.count) : PAGE_SIZE,
        restore,
      })
      setLoading(false)
    }
    void init()
  }, [router, loadPosts])

  // ── 离开页面：记住滚动位置与已加载条数 ──
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      try {
        sessionStorage.setItem(
          VIEW_STATE_KEY,
          JSON.stringify({ y: window.scrollY, count: postsRef.current.length })
        )
      } catch {
        // 忽略：记忆失败不影响功能
      }
    }
  }, [])

  // ── 作者身份卡：一次补齐本页新出现的作者，之后靠会话缓存 ──
  // 拿不到就什么都不展示 —— 作者身份是增强信息，失败不许影响 feed 本身。
  useEffect(() => {
    if (!accessToken || posts.length === 0) return
    let cancelled = false
    void fetchAuthorCards(
      accessToken,
      posts.map((p) => p.user_id)
    ).then((cards) => {
      if (!cancelled) setAuthorCards(cards)
    })
    return () => {
      cancelled = true
    }
  }, [posts, accessToken])

  // ── 触底加载下一页 ──
  useEffect(() => {
    if (!sentinelRef.current || !hasMore) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          !loadingMoreRef.current &&
          hasMoreRef.current &&
          tokenRef.current
        ) {
          void loadPosts(tokenRef.current, { append: true })
        }
      },
      { rootMargin: '300px' }
    )
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [hasMore, loadPosts])

  /** 下拉/手动刷新：重置分页后重新加载 */
  async function handleRefresh() {
    if (refreshing || !accessToken) return
    setRefreshing(true)
    offsetRef.current = 0
    hasMoreRef.current = true
    setHasMore(true)
    await loadPosts(accessToken)
    setRefreshing(false)
  }

  /** 点赞 / 收藏：乐观更新 + 服务端权威值校正 + 失败精确回退 */
  const handleToggle = useCallback(
    async (postId: string, type: 'like' | 'save') => {
      const token = tokenRef.current
      if (!token) return
      const key = `${postId}:${type}`
      if (busyRef.current.has(key)) return

      // 点击前的快照：失败时整体还原（旧版用"更新后的对象"回退，等于没回退）
      const snapshot = postsRef.current.find((p) => p.id === postId)
      if (!snapshot) return

      busyRef.current.add(key)
      setBusy(new Set(busyRef.current))

      setPosts((prev) =>
        prev.map((p) => {
          if (p.id !== postId) return p
          if (type === 'like') {
            const next = !p.current_user_liked
            return {
              ...p,
              current_user_liked: next,
              like_count: Math.max(0, p.like_count + (next ? 1 : -1)),
            }
          }
          const next = !p.current_user_saved
          return {
            ...p,
            current_user_saved: next,
            save_count: Math.max(0, p.save_count + (next ? 1 : -1)),
          }
        })
      )

      try {
        const state = await toggleInteraction(token, postId, type)
        // 以服务端返回值为准；字段缺失（服务端读回失败）时保留本地乐观值
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId
              ? {
                  ...p,
                  current_user_liked: state.liked ?? p.current_user_liked,
                  current_user_saved: state.saved ?? p.current_user_saved,
                  like_count: state.likeCount ?? p.like_count,
                  save_count: state.saveCount ?? p.save_count,
                  comment_count: state.commentCount ?? p.comment_count,
                }
              : p
          )
        )
      } catch (e) {
        setPosts((prev) => prev.map((p) => (p.id === postId ? snapshot : p)))
        setError(e instanceof Error ? e.message : '操作失败，请重试')
      } finally {
        busyRef.current.delete(key)
        setBusy(new Set(busyRef.current))
      }
    },
    []
  )

  const handleToggleLike = useCallback(
    (postId: string) => void handleToggle(postId, 'like'),
    [handleToggle]
  )
  const handleToggleSave = useCallback(
    (postId: string) => void handleToggle(postId, 'save'),
    [handleToggle]
  )

  const handleCommentAdded = useCallback((postId: string) => {
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId ? { ...p, comment_count: p.comment_count + 1 } : p
      )
    )
  }, [])

  /** 评论被删：直接用服务端返回的权威计数回写（并发下自己 -1 会算错） */
  const handleCommentDeleted = useCallback(
    (postId: string, commentCount: number) => {
      setPosts((prev) =>
        prev.map((p) => (p.id === postId ? { ...p, comment_count: commentCount } : p))
      )
    },
    []
  )

  /** 删除自己的帖子 */
  async function handleDeletePost(postId: string) {
    if (!accessToken || deletingId) return
    if (!confirm('确定删除这条灵感吗？')) return
    setDeletingId(postId)
    const snapshot = postsRef.current
    setPosts((prev) => prev.filter((p) => p.id !== postId))
    try {
      const res = await fetch(`/api/posts/${postId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        setError(data?.error ?? '删除失败')
        setPosts(snapshot)
      }
    } catch {
      setError('网络异常，删除失败')
      setPosts(snapshot)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <PageShell>
      {/* 定位：这是创作者社区，不是内容列表 */}
      <PageHeader
        eyebrow="创作者社区"
        title={hasStyleVector ? '为你匹配的创作者与想法' : '灵感广场'}
        description={
          hasStyleVector
            ? 'AI 按你的创作风格匹配了这些创作者。看他们的想法，聊两句，再回去创作。'
            : '这里不是内容列表，而是一群创作者在交换还没成型的想法。看看别人在想什么，也许你的下一篇就在这里。'
        }
        actions={
          <>
            <Link
              href="/publish"
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500"
            >
              发布灵感
            </Link>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/[0.1] px-3.5 py-2.5 text-[13px] font-medium text-zinc-300 transition hover:border-white/20 hover:text-white disabled:opacity-40"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              {refreshing ? '刷新中…' : '刷新'}
            </button>
          </>
        }
        ai={
          <AiStatus task="community" active={loading || refreshing} variant="bar" />
        }
      />

      {/* ── 错误提示 ── */}
      {error && (
        <ErrorState
          className="mb-6"
          message={error}
          onRetry={() => setError(null)}
          retryLabel="知道了"
        />
      )}

      {/* ── 加载中 ── */}
      {loading && <SkeletonList count={3} height={132} />}

      {/* ── 空状态 ── */}
      {!loading && posts.length === 0 && !error && (
        <EmptyState
          title="广场上还没有想法"
          description="把你正在琢磨的一句话发上来，其他创作者会看到，AI 也会据此认识你的关注点。"
          actionLabel="发布我的灵感"
          actionHref="/publish"
        />
      )}

        {/* ── Feed ── */}
        {!loading && posts.length > 0 && (
          <div className="space-y-4">
            {posts.map((post) => (
              <FeedPostCard
                key={post.id}
                post={post}
                token={accessToken}
                viewerId={viewerId}
                viewerName={viewerName}
                authorCard={authorCards[post.user_id]}
                busyLike={busy.has(`${post.id}:like`)}
                busySave={busy.has(`${post.id}:save`)}
                deleting={deletingId === post.id}
                onToggleLike={handleToggleLike}
                onToggleSave={handleToggleSave}
                onCommentAdded={handleCommentAdded}
                onCommentDeleted={handleCommentDeleted}
                onDelete={(id) => void handleDeletePost(id)}
              />
            ))}
          </div>
        )}

        {/* ── 触底哨兵 ── */}
        {!loading && hasMore && (
          <div
            ref={sentinelRef}
            className="flex items-center justify-center py-6"
          >
            {loadingMore && (
              <span className="animate-pulse text-sm text-zinc-500">加载更多…</span>
            )}
          </div>
        )}

        {/* ── 已加载全部 ── */}
        {!loading && !hasMore && posts.length > 0 && (
          <div className="flex items-center justify-center py-6">
            <span className="text-xs text-zinc-600">已经看到最后一条了</span>
          </div>
        )}
    </PageShell>
  )
}
