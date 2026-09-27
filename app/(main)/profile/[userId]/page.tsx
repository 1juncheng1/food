'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { getValidSession } from '@/lib/supabaseClient'
import { usePointAccount } from '@/hooks/use-point-account'
import { AuthorAvatar } from '@/components/community/author-badge'
import PostActionBar from '@/components/community/post-action-bar'
import CommentSection from '@/components/community/comment-section'
import ProfileEditor from '@/components/community/profile-editor'
import { toggleInteraction } from '@/lib/community/postApi'
import { extractTitleAndSummary, timeAgo } from '@/lib/community/format'
// 与服务端共用同一句文案，避免两处措辞漂移
import { MIN_GENERATION_COST, NO_BALANCE_MESSAGE } from '@/lib/balance'
import { amountForPoints } from '@/lib/points'
import type { ArchiveSnapshot } from '@/lib/creative/archive'
import { EmptyState, ErrorState, PageShell } from '@/components/vision'

// ────────────────────────────────────────────────────────────
// 作者主页：头像 + 昵称 + 简介 + 创作数量 + 发布作品
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

interface ProfilePost {
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
  post_type?: string | null
  archive?: ArchiveSnapshot | null
  current_user_liked: boolean
  current_user_saved: boolean
}

interface ProfileData {
  success: boolean
  userId: string
  authorName: string
  /** 0008 迁移新增：未执行时为 undefined → 首字母头像 */
  authorAvatarUrl?: string | null
  /** 个人简介：优先 Creator Profile 人格描述，无则 null */
  bio?: string | null
  isOwn: boolean
  isFollowing: boolean
  followerCount: number
  followingCount: number
  postCount: number
  styleProfile: StyleProfile | null
  posts: ProfilePost[]
  /** 0009 迁移新增：还有下一页作品（未执行迁移时为 undefined → 不再自动翻页） */
  postsHasMore?: boolean
}

/** 核心信息（不含 posts）：首屏优先渲染，不被作品列表阻塞 */
type ProfileInfo = Omit<ProfileData, 'posts'>

export default function ProfilePage() {
  const params = useParams<{ userId: string }>()
  const router = useRouter()
  // ── state 拆分（P0-3）：核心信息优先渲染，posts 独立加载 ──
  const [profileInfo, setProfileInfo] = useState<ProfileInfo | null>(null)
  const [posts, setPosts] = useState<ProfilePost[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [followBusy, setFollowBusy] = useState(false)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [viewerName, setViewerName] = useState<string>('')
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const busyRef = useRef<Set<string>>(new Set())
  const postsRef = useRef<ProfilePost[]>([])
  const tokenRef = useRef<string | null>(null)
  const loadingMoreRef = useRef(false)
  const hasMoreRef = useRef(false)
  const [openComments, setOpenComments] = useState<Set<string>>(new Set())
  // 账户余额：只在自己的主页查（别人的主页不该暴露我的余额）。
  // 连带拿回汇率，让「≈ ¥X」的换算与真实扣费口径一致。
  const { balance, pointsPerYuan } = usePointAccount(!!profileInfo?.isOwn)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    postsRef.current = posts
  }, [posts])

  useEffect(() => {
    hasMoreRef.current = hasMore
  }, [hasMore])

  /** 每页作品数：与 RPC 默认 limit 对齐 */
  const PAGE_SIZE = 20

  /** 加载个人主页数据（第一页）：核心信息 + 前 20 条作品 */
  const loadProfile = useCallback(
    async (token: string) => {
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const res = await fetch(
          `/api/profile/${params.userId}?postLimit=${PAGE_SIZE}&postOffset=0`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          }
        )
        if (!res.ok) {
          const errData = (await res.json().catch(() => null)) as { error?: string } | null
          setError(errData?.error ?? `加载失败（${res.status}）`)
          return
        }
        const json = (await res.json()) as { profile: ProfileData }
        const profile = json.profile
        // 拆分：核心信息（不含 posts）立即渲染，posts 独立 state
        const { posts: _posts, ...info } = profile
        setProfileInfo(info)
        setPosts(_posts ?? [])
        setHasMore(profile.postsHasMore ?? false)
        setOpenComments(new Set())
        setError(null)
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        setError('网络异常，请稍后重试')
      }
    },
    [params.userId]
  )

  /**
   * 加载下一页作品（服务端分页，只拉当页）。
   * offsetOverride：删除一条后用它按"删除后的长度"补位，避免跳过一条作品。
   */
  const loadMorePosts = useCallback(async (offsetOverride?: number) => {
    const token = tokenRef.current
    if (!token || loadingMoreRef.current) return
    const offset = offsetOverride ?? postsRef.current.length
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const res = await fetch(
        `/api/profile/${params.userId}?postLimit=${PAGE_SIZE}&postOffset=${offset}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!res.ok) return
      const json = (await res.json()) as { profile: ProfileData }
      const more = json.profile?.posts ?? []
      // 去重：翻页期间若有人新发了作品，offset 会错位导致同一条出现两次
      setPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id))
        return [...prev, ...more.filter((p) => !seen.has(p.id))]
      })
      setHasMore(json.profile?.postsHasMore ?? false)
    } catch {
      // 翻页失败不打断浏览：保留已加载内容，交回给用户再滚一次重试
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [params.userId])

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
        setProfileInfo((prev) =>
          prev
            ? {
                ...prev,
                isFollowing: wasFollowing,
                followerCount: prev.followerCount + (wasFollowing ? 1 : -1),
              }
            : prev
        )
        const errData = (await res.json().catch(() => null)) as { error?: string } | null
        setError(errData?.error ?? '操作失败')
      } else {
        setError(null)
      }
    } catch {
      setError('网络异常，请稍后重试')
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

  /** 点赞 / 收藏：乐观更新 + 服务端权威值校正 + 失败精确回退 */
  const handleToggle = useCallback(
    async (postId: string, type: 'like' | 'save') => {
      if (!accessToken) return
      const key = `${postId}:${type}`
      if (busyRef.current.has(key)) return
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
        const state = await toggleInteraction(accessToken, postId, type)
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
    [accessToken]
  )

  /** 删除帖子（乐观更新 posts + profileInfo.postCount）*/
  async function handleDeletePost(postId: string) {
    if (!accessToken || deletingId) return
    if (!confirm('确定删除这条灵感吗？')) return

    setDeletingId(postId)
    const snapshotPosts = postsRef.current
    const snapshotCount = profileInfo?.postCount ?? 0
    setPosts((prev) => prev.filter((p) => p.id !== postId))
    setProfileInfo((prev) => (prev ? { ...prev, postCount: prev.postCount - 1 } : prev))

    try {
      const res = await fetch(`/api/posts/${postId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) {
        setError('删除失败，已恢复')
        setPosts(snapshotPosts)
        setProfileInfo((prev) => (prev ? { ...prev, postCount: snapshotCount } : prev))
        return
      }
      // offset 分页的固有代价：删掉一条后整体前移，直接翻页会跳过一条。
      // 还有下一页时按"删除后的长度"补拉一条，把空位填上。
      if (hasMoreRef.current) {
        await loadMorePosts(snapshotPosts.length - 1)
      }
    } catch {
      setError('网络异常，删除失败')
      setPosts(snapshotPosts)
      setProfileInfo((prev) => (prev ? { ...prev, postCount: snapshotCount } : prev))
    } finally {
      setDeletingId(null)
    }
  }

  // ── IntersectionObserver：触底加载下一页（服务端分页）──
  useEffect(() => {
    if (!sentinelRef.current || !hasMore || loadingMore) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMorePosts()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, loadMorePosts])

  useEffect(() => {
    async function init() {
      const session = await getValidSession()
      if (!session) {
        router.replace('/login')
        return
      }
      const metaName = session.user.user_metadata?.display_name
      setAccessToken(session.access_token)
      tokenRef.current = session.access_token
      setViewerId(session.user.id)
      setViewerName(
        typeof metaName === 'string' && metaName.trim()
          ? metaName.trim()
          : session.user.email?.split('@')[0] ?? ''
      )
      setLoading(true)
      await loadProfile(session.access_token)
      setLoading(false)
    }
    void init()
  }, [params.userId, router, loadProfile])

  if (loading) {
    return (
      <div className="inner-page " data-mode="inspiration">
        <div className="inner-container">
          <div className="space-y-6">
            <div className="h-16 vs-skeleton" />
            <div className="h-32 vs-skeleton" />
          </div>
        </div>
      </div>
    )
  }

  if (error && !profileInfo) {
    return (
      <div className="inner-page " data-mode="inspiration">
        <div className="inner-container">
          <div className="vs-error flex items-center justify-between gap-4">
            <p className="text-[14px]">{error}</p>
            <Link
              href="/explore"
              className="vs-link shrink-0"
            >
              回到灵感广场
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (!profileInfo) return null

  const creator = profileInfo.styleProfile?.creator ?? null
  const bio = profileInfo.bio?.trim() || creator?.description?.trim() || ''

  /** 语言事实（语气/节奏/开头/篇幅）：人格卡内折叠展示；无人格时平铺 */
  const styleFacts = profileInfo.styleProfile ? (
    <>
      <div className="mb-5">
        <p className="vs-mark mb-2.5">语气标签</p>
        <div className="flex flex-wrap gap-2">
          {profileInfo.styleProfile.tone_tags.length > 0 ? (
            profileInfo.styleProfile.tone_tags.map((tag) => (
              <span
                key={tag}
                className="vs-verdict"
              >
                {tag}
              </span>
            ))
          ) : (
            <span className="vs-note">暂无</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <p className="vs-mark mb-1.5">节奏偏好</p>
          <p className="text-[14px] text-[var(--vs-ink-2)]">
            {profileInfo.styleProfile.pace_preference || '未知'}
          </p>
        </div>
        <div>
          <p className="vs-mark mb-1.5">常用开头</p>
          <p className="text-[14px] text-[var(--vs-ink-2)]">
            {profileInfo.styleProfile.common_opening || '未知'}
          </p>
        </div>
        <div>
          <p className="vs-mark mb-1.5">平均字数</p>
          <p className="text-[14px] text-[var(--vs-ink-2)]">{profileInfo.styleProfile.avg_length || 0}</p>
        </div>
      </div>
    </>
  ) : null

  return (
    <PageShell width="narrow">
        <Link
          href="/explore"
          className="mb-6 vs-link"
        >
          ← 返回灵感广场
        </Link>

        {error && <ErrorState className="mb-6" message={error} />}

        {/* ── 作者卡片：这里是社区里的「人」，不是账号详情页 ── */}
        <div className="mb-6 rounded-2xl border border-white/[0.08] bg-[var(--vs-void-1)] px-6 py-6">
          <div className="flex items-start gap-4 flex-wrap">
            <AuthorAvatar
              name={profileInfo.authorName}
              avatarUrl={profileInfo.authorAvatarUrl}
              size="lg"
            />
            <div className="min-w-0 flex-1">
              <h1 className="vs-h2">
                {profileInfo.authorName || '创作者'}
              </h1>
              {bio ? (
                <p className="text-[14px] mt-2 leading-relaxed max-w-2xl text-[var(--vs-ink-3)]">
                  {bio}
                </p>
              ) : (
                <p className="mt-2 vs-note">
                  这位创作者还没有留下简介
                </p>
              )}
              <div className="flex gap-5 mt-3 text-[14px] text-[var(--vs-ink-3)]">
                <span>
                  <span className="font-medium text-[var(--vs-ink)]">{profileInfo.postCount}</span>{' '}
                  创作
                </span>
                <span>
                  <span className="font-medium text-[var(--vs-ink)]">
                    {profileInfo.followerCount}
                  </span>{' '}
                  粉丝
                </span>
                <span>
                  <span className="font-medium text-[var(--vs-ink)]">
                    {profileInfo.followingCount}
                  </span>{' '}
                  关注
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
                    ? 'vs-btn vs-btn-ghost vs-btn-sm'
                    : 'vs-btn vs-btn-primary vs-btn-sm'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {followBusy ? '处理中…' : profileInfo.isFollowing ? '已关注' : '关注'}
              </button>
            )}

            {/* 账户余额（仅本人可见） */}
            {profileInfo.isOwn && balance !== null && (
              balance < MIN_GENERATION_COST ? (
                <div className="shrink-0 flex items-start gap-2 vs-frame vs-warn px-4 py-2.5">
                  <div>
                    <p className="text-[14px] font-medium leading-tight text-[var(--vs-ink)]">
                      {NO_BALANCE_MESSAGE}
                    </p>
                    <Link
                      href="/recharge"
                      className="vs-btn vs-btn-ghost vs-btn-sm mt-1"
                    >
                      去充值
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="shrink-0 vs-frame px-4 py-2.5 text-right">
                  <p className="vs-note leading-tight">账户余额</p>
                  <p className="vs-num font-medium leading-tight mt-0.5">
                    {balance} 积分
                  </p>
                  {pointsPerYuan !== null && (
                    <p className="vs-note leading-tight mt-0.5">
                      ≈ ¥{amountForPoints(balance, pointsPerYuan).toFixed(2)}
                    </p>
                  )}
                  <Link
                    href="/recharge"
                    className="vs-link mt-1 text-[11px]"
                  >
                    充值
                  </Link>
                </div>
              )
            )}

            {/* 编辑资料（仅本人）：昵称 + 头像 */}
            {profileInfo.isOwn && !editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="vs-btn vs-btn-ghost vs-btn-sm shrink-0"
              >
                编辑资料
              </button>
            )}
          </div>

          {profileInfo.isOwn && editing && accessToken && (
            <ProfileEditor
              token={accessToken}
              initialName={profileInfo.authorName}
              initialAvatar={profileInfo.authorAvatarUrl ?? null}
              onSaved={(p) => {
                setProfileInfo((prev) =>
                  prev
                    ? {
                        ...prev,
                        authorName: p.displayName || prev.authorName,
                        authorAvatarUrl: p.avatarUrl,
                      }
                    : prev
                )
                setViewerName(p.displayName || viewerName)
                setEditing(false)
              }}
              onCancel={() => setEditing(false)}
            />
          )}
        </div>

        {/* ── 创作者人格 ── */}
        {creator ? (
          <div className="mb-6 rounded-2xl border border-white/[0.08] bg-[var(--vs-void-1)] px-6 py-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="vs-h3">创作者人格</h2>
              {profileInfo.isOwn && (
                <Link
                  href="/style-profile"
                  className="vs-link"
                >
                  查看完整 DNA →
                </Link>
              )}
            </div>

            <h3 className="vs-h2">
              {creator.main || '未命名人格'}
              {creator.sub && (
                <span className="vs-note ml-2">
                  × {creator.sub}
                </span>
              )}
            </h3>

            {creator.description && (
              <p className="text-[14px] mt-3 leading-loose text-[var(--vs-ink-2)]">
                {creator.description}
              </p>
            )}

            {(creator.motifs.length > 0 || creator.narratives.length > 0) && (
              <div className="mt-4 space-y-2.5">
                {creator.motifs.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="vs-mark">持续关注的母题</span>
                    {creator.motifs.map((m) => (
                      <span
                        key={m}
                        className="vs-verdict"
                      >
                        {m}
                      </span>
                    ))}
                  </div>
                )}
                {creator.narratives.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="vs-mark">叙事特征</span>
                    {creator.narratives.map((n) => (
                      <span
                        key={n}
                        className="vs-verdict"
                      >
                        {n}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <details className="mt-5 group">
              <summary className="vs-note cursor-pointer select-none list-none transition hover:text-[var(--vs-ink)]">
                <span className="inline-block group-open:rotate-90 transition-transform mr-1">
                  ▸
                </span>
                语言特征（语气 · 节奏 · 开头 · 篇幅）
              </summary>
              <div className="mt-4">{styleFacts}</div>
            </details>
          </div>
        ) : profileInfo.styleProfile ? (
          <div className="mb-6 rounded-2xl border border-white/[0.08] bg-[var(--vs-void-1)] px-6 py-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="vs-h3">创作风格</h2>
              <span className="vs-mark">
                {profileInfo.styleProfile.source === 'manual' ? '手动编辑' : '自动统计'}
              </span>
            </div>
            {styleFacts}
          </div>
        ) : null}

        {/* ── 发布作品 ── */}
        <div>
          <div className="mb-4 flex items-baseline gap-2">
            <h2 className="vs-h3">
              发布的作品
            </h2>
            {posts.length > 0 && (
              <span className="vs-mark">{posts.length} 条</span>
            )}
          </div>
          {posts.length === 0 ? (
            <EmptyState
              title={profileInfo.isOwn ? '你还没有发布过作品' : 'TA 还没有公开作品'}
              description={
                profileInfo.isOwn
                  ? '把你正在琢磨的一句话发到广场。别人的回应，往往就是你下一篇的起点。'
                  : '关注一下，等 TA 发布新想法。'
              }
              {...(profileInfo.isOwn
                ? { actionLabel: '发布我的灵感', actionHref: '/publish' }
                : {})}
            />
          ) : (
            <div className="space-y-4">
              {posts.map((post) => {
                const { title, summary } = extractTitleAndSummary(post.content)
                const isArchive = post.post_type === 'archive' && !!post.archive
                const heading = isArchive
                  ? post.archive!.title || title
                  : title || '灵感分享'
                const commentsOpen = openComments.has(post.id)

                return (
                  <article
                    key={post.id}
                    onClick={() => router.push(`/post/${post.id}`)}
                    className="vs-frame cursor-pointer px-6 py-5 transition hover:border-[var(--vs-line-2)]"
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <span className="vs-verdict shrink-0">
                        {post.category}
                      </span>
                      <span className="vs-note">{timeAgo(post.created_at)}</span>
                      {isArchive && (
                        <span className="vs-verdict">
                           创作档案
                        </span>
                      )}
                      {profileInfo.isOwn && (
                        <button
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            void handleDeletePost(post.id)
                          }}
                          disabled={deletingId === post.id}
                          className="vs-link-danger ml-auto disabled:opacity-40"
                        >
                          {deletingId === post.id ? '删除中…' : '删除'}
                        </button>
                      )}
                    </div>

                    <h3 className="vs-h3 mb-2 leading-snug">
                      {heading}
                    </h3>

                    {summary && (
                      <p className="text-[14px] leading-relaxed text-[var(--vs-ink-2)] mb-3 whitespace-pre-wrap">
                        {summary}
                      </p>
                    )}

                    {post.image_url && (
                      <div className="mb-3">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={post.image_url}
                          alt="帖子图片"
                          className="w-full max-h-64 object-cover rounded-[var(--vs-r)] border border-[var(--vs-line)]"
                        />
                      </div>
                    )}

                    {post.tags && post.tags.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-3">
                        {post.tags.map((tag) => (
                          <span
                            key={tag}
                            className="vs-verdict"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}

                    <PostActionBar
                      postId={post.id}
                      liked={post.current_user_liked}
                      saved={post.current_user_saved}
                      likeCount={post.like_count}
                      commentCount={post.comment_count}
                      saveCount={post.save_count}
                      busyLike={busy.has(`${post.id}:like`)}
                      busySave={busy.has(`${post.id}:save`)}
                      onToggleLike={() => void handleToggle(post.id, 'like')}
                      onToggleSave={() => void handleToggle(post.id, 'save')}
                      onToggleComments={() =>
                        setOpenComments((prev) => {
                          const next = new Set(prev)
                          if (next.has(post.id)) next.delete(post.id)
                          else next.add(post.id)
                          return next
                        })
                      }
                      commentsOpen={commentsOpen}
                    />

                    {commentsOpen && (
                      <div onClick={(e) => e.stopPropagation()}>
                        <CommentSection
                          postId={post.id}
                          token={accessToken}
                          viewerName={viewerName}
                          viewerId={viewerId ?? undefined}
                          onCommentAdded={() =>
                            setPosts((prev) =>
                              prev.map((p) =>
                                p.id === post.id
                                  ? { ...p, comment_count: p.comment_count + 1 }
                                  : p
                              )
                            )
                          }
                          onCommentDeleted={(count) =>
                            setPosts((prev) =>
                              prev.map((p) =>
                                p.id === post.id ? { ...p, comment_count: count } : p
                              )
                            )
                          }
                        />
                      </div>
                    )}
                  </article>
                )
              })}

              {hasMore && (
                <div
                  ref={sentinelRef}
                  className="flex items-center justify-center py-6"
                >
                  <span className="vs-note">加载更多…</span>
                </div>
              )}

              {!hasMore && posts.length > 0 && (
                <div className="flex items-center justify-center py-6">
                  <span className="vs-note">没有更多了</span>
                </div>
              )}
            </div>
          )}
        </div>
    </PageShell>
  )
}
