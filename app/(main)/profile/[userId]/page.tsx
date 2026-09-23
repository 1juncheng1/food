'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'

// ────────────────────────────────────────────────────────────
// 个人主页：展示创作者人格 + 语言特征 + 发布的帖子 + 关注按钮
// 路径：/profile/[userId]
// 数据源：get_user_profile RPC（统一从 Creator Profile 读取）
// ────────────────────────────────────────────────────────────

interface StyleProfile {
  tone_tags: string[]
  pace_preference: string
  common_opening: string
  avg_length: number
  source: string
  /** 创作者人格摘要（get_user_profile 从 9.6 报告提取；未生成报告时为 null） */
  creator: {
    main: string
    sub: string
    description: string
    confidence: number | null
    motifs: string[]
    narratives: string[]
  } | null
}

interface Post {
  id: string
  content: string
  content_type: string
  category: string
  tags: string[]
  like_count: number
  comment_count: number
  save_count: number
  image_url: string | null
  created_at: string
  current_user_liked: boolean
  current_user_saved: boolean
}

interface ProfileData {
  success: boolean
  userId: string
  authorName: string
  isOwn: boolean
  isFollowing: boolean
  followerCount: number
  followingCount: number
  postCount: number
  styleProfile: StyleProfile | null
  posts: Post[]
}

/** 核心信息（不含 posts）：首屏优先渲染，不被作品列表阻塞 */
type ProfileInfo = Omit<ProfileData, 'posts'>

/** 格式化时间为相对时间 */
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

/** 取内容摘要 */
function getContentSummary(content: string): string {
  const cleanContent = content.replace(/\n\n\[图片描述\][\s\S]*$/, '')
  const text = cleanContent || content
  return text.length > 200 ? text.slice(0, 200) + '…' : text
}

export default function ProfilePage() {
  const params = useParams<{ userId: string }>()
  const router = useRouter()
  // ── state 拆分（P0-3）：核心信息优先渲染，posts 独立加载 ──
  // profileInfo：用户卡 + 统计 + 风格卡（不含 posts 数组）
  // posts：作品列表独立 state，客户端切片显示（前 10 条，触底"查看更多"）
  const [profileInfo, setProfileInfo] = useState<ProfileInfo | null>(null)
  const [posts, setPosts] = useState<Post[]>([])
  const [visibleCount, setVisibleCount] = useState(10)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [followBusy, setFollowBusy] = useState(false)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // 客户端切片显示：visibleCount 控制当前展示条数，触底加载更多
  const visiblePosts = posts.slice(0, visibleCount)
  const hasMorePosts = visibleCount < posts.length
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  /** 加载个人主页数据：拆分为核心信息 + posts 两个独立 state */
  const loadProfile = useCallback(
    async (token: string) => {
      // P2-1：路由切换时 abort 旧请求，避免旧响应覆盖新页面数据
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const res = await fetch(`/api/profile/${params.userId}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
        if (!res.ok) {
          const errData = await res.json().catch(() => null)
          setError(errData?.error ?? `加载失败（${res.status}）`)
          return
        }
        const json = await res.json()
        const profile: ProfileData = json.profile
        // 拆分：核心信息（不含 posts）立即渲染，posts 独立 state
        const { posts: _posts, ...info } = profile
        setProfileInfo(info)
        setPosts(_posts ?? [])
        setVisibleCount(10) // 重置切片
        setError(null)
      } catch (e) {
        // AbortError 静默：路由切换触发的取消是预期行为
        if (e instanceof Error && e.name === 'AbortError') return
        setError('网络异常，请稍后重试')
      }
    },
    [params.userId]
  )

  // P2-1：组件卸载时 abort 进行中的请求
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  /** 关注/取消关注 */
  async function handleToggleFollow() {
    if (!accessToken || !profileInfo || followBusy) return
    setFollowBusy(true)
    const wasFollowing = profileInfo.isFollowing

    // 乐观更新
    setProfileInfo((prev) =>
      prev
        ? {
            ...prev,
            isFollowing: !wasFollowing,
            followerCount: prev.followerCount + (wasFollowing ? -1 : 1),
          }
        : prev
    )

    try {
      const res = await fetch('/api/follows', {
        method: wasFollowing ? 'DELETE' : 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ followingId: params.userId }),
      })
      if (!res.ok) {
        // 回退
        setProfileInfo((prev) =>
          prev
            ? {
                ...prev,
                isFollowing: wasFollowing,
                followerCount: prev.followerCount + (wasFollowing ? 1 : -1),
              }
            : prev
        )
        const errData = await res.json().catch(() => null)
        setError(errData?.error ?? '操作失败')
      } else {
        setError(null)
      }
    } catch {
      setError('网络异常，请稍后重试')
      // 回退
      setProfileInfo((prev) =>
        prev
          ? {
              ...prev,
              isFollowing: wasFollowing,
              followerCount: prev.followerCount + (wasFollowing ? 1 : -1),
            }
          : prev
      )
    } finally {
      setFollowBusy(false)
    }
  }

  /** 删除帖子（乐观更新 posts + profileInfo.postCount）*/
  async function handleDeletePost(postId: string) {
    if (!accessToken || deletingId) return
    if (!confirm('确定删除这条灵感吗？')) return

    setDeletingId(postId)
    // 乐观删除：立即从 posts 移除 + postCount - 1
    setPosts((prev) => prev.filter((p) => p.id !== postId))
    setProfileInfo((prev) =>
      prev ? { ...prev, postCount: prev.postCount - 1 } : prev
    )

    try {
      const res = await fetch(`/api/posts/${postId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) {
        // 删除失败：重新加载恢复
        setError('删除失败，已恢复')
        await loadProfile(accessToken)
      }
    } catch {
      setError('网络异常，删除失败')
      await loadProfile(accessToken)
    } finally {
      setDeletingId(null)
    }
  }

  // ── IntersectionObserver：触底"查看更多"（客户端切片，无网络请求）──
  useEffect(() => {
    if (!sentinelRef.current || !hasMorePosts) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((prev) => prev + 10)
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [hasMorePosts])

  useEffect(() => {
    async function init() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.replace('/login')
        return
      }
      setAccessToken(session.access_token)
      setLoading(true)
      await loadProfile(session.access_token)
      setLoading(false)
    }
    init()
  }, [params.userId, router, loadProfile])

  if (loading) {
    return (
      <div className="inner-page gen-stage" data-mode="inspiration">
        <div className="inner-container">
          <div className="animate-pulse space-y-6">
            <div className="h-16 bg-zinc-900 rounded-xl" />
            <div className="h-32 bg-zinc-900 rounded-xl" />
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="inner-page gen-stage" data-mode="inspiration">
        <div className="inner-container">
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-5 py-4">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        </div>
      </div>
    )
  }

  if (!profileInfo) return null

  const initial = profileInfo.authorName ? profileInfo.authorName[0].toUpperCase() : 'U'
  const creator = profileInfo.styleProfile?.creator ?? null

  /** 语言事实（语气/节奏/开头/篇幅）：人格卡内折叠展示；无人格时平铺 */
  const styleFacts = profileInfo.styleProfile ? (
    <>
      {/* 语气标签 */}
      <div className="mb-5">
        <p className="text-xs text-zinc-500 mb-2.5">语气标签</p>
        <div className="flex flex-wrap gap-2">
          {profileInfo.styleProfile.tone_tags.length > 0 ? (
            profileInfo.styleProfile.tone_tags.map((tag) => (
              <span
                key={tag}
                className="text-xs px-2.5 py-1 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"
              >
                {tag}
              </span>
            ))
          ) : (
            <span className="text-xs text-zinc-600">暂无</span>
          )}
        </div>
      </div>

      {/* 节奏偏好 + 常用开头 + 平均字数 */}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <p className="text-xs text-zinc-500 mb-1.5">节奏偏好</p>
          <p className="text-sm text-zinc-300">
            {profileInfo.styleProfile.pace_preference || '未知'}
          </p>
        </div>
        <div>
          <p className="text-xs text-zinc-500 mb-1.5">常用开头</p>
          <p className="text-sm text-zinc-300">
            {profileInfo.styleProfile.common_opening || '未知'}
          </p>
        </div>
        <div>
          <p className="text-xs text-zinc-500 mb-1.5">平均字数</p>
          <p className="text-sm text-zinc-300">
            {profileInfo.styleProfile.avg_length || 0}
          </p>
        </div>
      </div>
    </>
  ) : null

  return (
    <div className="inner-page">
      <div className="inner-container">
        {/* ── 用户信息卡片 ── */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-6 mb-6">
          <div className="flex items-start gap-4">
            {/* 头像 */}
            <div className="w-16 h-16 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-2xl font-medium shrink-0">
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold text-white">
                {profileInfo.authorName || '未知用户'}
              </h1>
              <div className="flex gap-5 mt-2 text-sm text-zinc-400">
                <span>
                  <span className="text-zinc-200 font-medium">{profileInfo.postCount}</span> 帖子
                </span>
                <span>
                  <span className="text-zinc-200 font-medium">{profileInfo.followerCount}</span> 粉丝
                </span>
                <span>
                  <span className="text-zinc-200 font-medium">{profileInfo.followingCount}</span> 关注
                </span>
              </div>
            </div>

            {/* 关注按钮（不是自己时显示） */}
            {!profileInfo.isOwn && (
              <button
                onClick={handleToggleFollow}
                disabled={followBusy}
                className={`px-5 py-2 rounded-lg text-sm font-medium transition shrink-0 ${
                  profileInfo.isFollowing
                    ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                    : 'bg-indigo-600 text-white hover:bg-indigo-500'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {followBusy ? '处理中…' : profileInfo.isFollowing ? '已关注' : '关注'}
              </button>
            )}
          </div>
        </div>

        {/* ── 创作者人格 + 语言特征 ── */}
        {creator ? (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-zinc-200">创作者人格</h2>
              {profileInfo.isOwn && (
                <Link
                  href="/style-profile"
                  className="text-xs text-indigo-400 hover:text-indigo-300 transition"
                >
                  查看完整 DNA →
                </Link>
              )}
            </div>

            <h3 className="text-xl font-semibold text-white">
              {creator.main || '未命名人格'}
              {creator.sub && (
                <span className="ml-2 text-sm font-normal text-zinc-400">× {creator.sub}</span>
              )}
            </h3>

            {creator.description && (
              <p className="mt-3 text-sm text-zinc-300 leading-loose">{creator.description}</p>
            )}

            {(creator.motifs.length > 0 || creator.narratives.length > 0) && (
              <div className="mt-4 space-y-2.5">
                {creator.motifs.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-zinc-500">持续关注的母题</span>
                    {creator.motifs.map((m) => (
                      <span
                        key={m}
                        className="text-xs px-2.5 py-1 rounded-lg bg-indigo-500/10 text-indigo-300 border border-indigo-500/20"
                      >
                        {m}
                      </span>
                    ))}
                  </div>
                )}
                {creator.narratives.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-zinc-500">叙事特征</span>
                    {creator.narratives.map((n) => (
                      <span
                        key={n}
                        className="text-xs px-2.5 py-1 rounded-lg bg-purple-500/10 text-purple-300 border border-purple-500/20"
                      >
                        {n}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 语言事实折叠区 */}
            <details className="mt-5 group">
              <summary className="cursor-pointer select-none text-xs text-zinc-500 hover:text-zinc-300 transition list-none">
                <span className="inline-block group-open:rotate-90 transition-transform mr-1">
                  ▸
                </span>
                语言特征（语气 · 节奏 · 开头 · 篇幅）
              </summary>
              <div className="mt-4">{styleFacts}</div>
            </details>
          </div>
        ) : profileInfo.styleProfile ? (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-6 mb-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-sm font-medium text-zinc-200">创作风格</h2>
              <span className="text-xs text-zinc-500">
                {profileInfo.styleProfile.source === 'manual' ? '手动编辑' : '自动统计'}
              </span>
            </div>
            {styleFacts}
          </div>
        ) : (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-6 mb-6">
            <p className="text-sm text-zinc-500 text-center">暂无风格数据</p>
          </div>
        )}

        {/* ── 帖子列表 ── */}
        <div>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">发布的灵感</h2>
          {posts.length === 0 ? (
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-8">
              <p className="text-sm text-zinc-500 text-center">还没有发布过灵感</p>
            </div>
          ) : (
            <div className="space-y-4">
              {visiblePosts.map((post) => {
                const summary = getContentSummary(post.content)
                return (
                  <div
                    key={post.id}
                    className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-5 hover:border-zinc-700 transition"
                  >
                    {/* 帖子头部 */}
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-xs px-2.5 py-1 rounded-lg bg-zinc-800 text-zinc-400 shrink-0">
                        {post.category}
                      </span>
                      <span className="text-xs text-zinc-600">{timeAgo(post.created_at)}</span>
                      {/* 删除按钮（仅自己的帖子显示） */}
                      {profileInfo.isOwn && (
                        <button
                          onClick={() => handleDeletePost(post.id)}
                          disabled={deletingId === post.id}
                          className="ml-auto text-xs text-zinc-600 hover:text-red-400 disabled:opacity-40 transition"
                        >
                          {deletingId === post.id ? '删除中…' : '删除'}
                        </button>
                      )}
                    </div>

                    {/* 内容摘要 */}
                    <p className="text-sm text-zinc-300 leading-relaxed mb-3">
                      {summary}
                    </p>

                    {/* 图片缩略图 */}
                    {post.image_url && (
                      <div className="mb-3">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={post.image_url}
                          alt="帖子图片"
                          className="w-full max-h-64 object-cover rounded-xl border border-zinc-800"
                        />
                      </div>
                    )}

                    {/* 标签 */}
                    {post.tags && post.tags.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-3">
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

                    {/* 互动统计 */}
                    <div className="flex items-center gap-5 text-xs text-zinc-500">
                      <span className="flex items-center gap-1.5">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={post.current_user_liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={post.current_user_liked ? 'text-red-400' : ''}>
                          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                        </svg>
                        {post.like_count}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                        </svg>
                        {post.comment_count}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={post.current_user_saved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={post.current_user_saved ? 'text-amber-400' : ''}>
                          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                        </svg>
                        {post.save_count}
                      </span>
                    </div>
                  </div>
                )
              })}

              {/* ── 触底哨兵：客户端切片显示更多（P0-3）── */}
              {hasMorePosts && (
                <div
                  ref={sentinelRef}
                  className="flex items-center justify-center py-6"
                >
                  <span className="animate-pulse text-sm text-zinc-500">
                    加载更多…
                  </span>
                </div>
              )}

              {/* ── 已显示全部 ── */}
              {!hasMorePosts && posts.length > 0 && (
                <div className="flex items-center justify-center py-6">
                  <span className="text-xs text-zinc-600">没有更多了</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
