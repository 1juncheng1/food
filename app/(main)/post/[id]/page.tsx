'use client'

// 帖子详情页（/post/[id]）
// moment：普通灵感正文 + 图片
// archive：完整创作档案叙事——灵感起点 → AI 创作方向 → 版本变化记录 → 最终作品 → 作者总结
// 档案展示的是发布瞬间的只读快照，与作品之后的迭代无关。
//
// 社区化补齐：作者卡（头像/昵称/主页入口）+ 互动按钮（点赞/收藏/分享）+ 评论区，
// 让"阅读 → 讨论 → 查看作者"在详情页内闭环，而不必回到广场。

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { getValidSession } from '@/lib/supabaseClient'
import { EmptyState, PageShell, SkeletonList } from '@/components/vision'
import AuthorBadge from '@/components/community/author-badge'
import PostActionBar from '@/components/community/post-action-bar'
import CommentSection from '@/components/community/comment-section'
import { toggleInteraction } from '@/lib/community/postApi'
import { extractTitleAndSummary, formatDateTime } from '@/lib/community/format'
import type { ArchiveSnapshot } from '@/lib/creative/archive'

interface PostDetail {
  id: string
  user_id: string
  content: string
  content_type: string
  category: string
  tags: string[] | null
  like_count: number
  comment_count: number
  save_count: number
  created_at: string
  author_name: string
  author_avatar_url?: string | null
  current_user_liked: boolean
  current_user_saved: boolean
  image_url: string | null
  post_type: string
  archive: ArchiveSnapshot | null
  source_project_id: string | null
}

export default function PostDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [post, setPost] = useState<PostDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [viewerName, setViewerName] = useState<string>('')
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const busyRef = useRef<Set<string>>(new Set())
  const postRef = useRef<PostDetail | null>(null)

  useEffect(() => {
    postRef.current = post
  }, [post])

  // 加载函数定义在 effect 内部（与 /explore 同模式），避免 effect 内同步 setState
  useEffect(() => {
    if (!params.id) return

    async function load(id: string) {
      const session = await getValidSession()
      if (!session) {
        setError('请先登录后查看')
        setLoading(false)
        return
      }
      setToken(session.access_token)
      setViewerId(session.user.id)
      const metaName = session.user.user_metadata?.display_name
      setViewerName(
        typeof metaName === 'string' && metaName.trim()
          ? metaName.trim()
          : session.user.email?.split('@')[0] ?? ''
      )
      setError(null)
      try {
        const res = await fetch(`/api/posts/${id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const data = (await res.json().catch(() => null)) as
          | { post?: PostDetail; error?: string }
          | null
        if (!res.ok || !data?.post) {
          setError(data?.error ?? '帖子不存在或未公开')
        } else {
          setPost(data.post)
        }
      } catch {
        setError('网络异常，请稍后重试')
      } finally {
        setLoading(false)
      }
    }

    void load(params.id)
  }, [params.id])

  /** 点赞 / 收藏：乐观更新 + 服务端权威值校正 + 失败精确回退 */
  const handleToggle = useCallback(
    async (type: 'like' | 'save') => {
      const current = postRef.current
      if (!token || !current) return
      const key = type
      if (busyRef.current.has(key)) return

      const snapshot = current
      busyRef.current.add(key)
      setBusy(new Set(busyRef.current))

      setPost((prev) => {
        if (!prev) return prev
        if (type === 'like') {
          const next = !prev.current_user_liked
          return {
            ...prev,
            current_user_liked: next,
            like_count: Math.max(0, prev.like_count + (next ? 1 : -1)),
          }
        }
        const next = !prev.current_user_saved
        return {
          ...prev,
          current_user_saved: next,
          save_count: Math.max(0, prev.save_count + (next ? 1 : -1)),
        }
      })

      try {
        const state = await toggleInteraction(token, current.id, type)
        setPost((prev) =>
          prev
            ? {
                ...prev,
                current_user_liked: state.liked ?? prev.current_user_liked,
                current_user_saved: state.saved ?? prev.current_user_saved,
                like_count: state.likeCount ?? prev.like_count,
                save_count: state.saveCount ?? prev.save_count,
                comment_count: state.commentCount ?? prev.comment_count,
              }
            : prev
        )
      } catch (e) {
        setPost(snapshot)
        setError(e instanceof Error ? e.message : '操作失败，请重试')
      } finally {
        busyRef.current.delete(key)
        setBusy(new Set(busyRef.current))
      }
    },
    [token]
  )

  /** 删除自己的作品：成功后回广场（详情页没了，留在原页只会显示"不存在"） */
  const handleDeletePost = useCallback(async () => {
    const current = postRef.current
    if (!token || !current || deleting) return
    if (!confirm('确定删除这篇灵感吗？')) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/posts/${current.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        setError(data?.error ?? '删除失败')
        return
      }
      router.replace('/explore')
    } catch {
      setError('网络异常，删除失败')
    } finally {
      setDeleting(false)
    }
  }, [token, deleting, router])

  const isArchive = post?.post_type === 'archive' && post.archive
  const plainTitle = post ? extractTitleAndSummary(post.content).title : ''
  const heading = isArchive ? post!.archive!.title || plainTitle : plainTitle || '灵感分享'
  const isOwn = !!post && !!viewerId && viewerId === post.user_id

  return (
    <PageShell width="narrow">
        <Link
          href="/explore"
          className="mb-6 inline-flex items-center gap-1.5 text-[13px] text-zinc-500 transition hover:text-zinc-200"
        >
          ← 返回灵感广场
        </Link>

        {loading && <SkeletonList count={2} height={132} />}

        {error && !loading && (
          <EmptyState
            title="这条内容没能打开"
            description={error}
            actionLabel="回到灵感广场"
            actionHref="/explore"
          />
        )}

        {post && !loading && (
          <article className="space-y-6">
            {/* ── 标题 + 元信息 ── */}
            <header>
              {isArchive && (
                <span className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-indigo-500/15 text-indigo-300 border border-indigo-500/25 mb-3">
                  📖 创作档案 · AI 协作全过程
                </span>
              )}
              <h1 className="text-xl font-bold text-zinc-100 leading-snug">{heading}</h1>
              <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-3 text-xs text-zinc-500">
                <span className="px-2 py-0.5 rounded bg-zinc-800/80 text-zinc-400">
                  {post.category}
                </span>
                <span>{formatDateTime(post.created_at)}</span>
              </div>
            </header>

            {/* ── 作者卡：点击头像/昵称进作者主页 ── */}
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-5">
              <AuthorBadge
                userId={post.user_id}
                name={post.author_name}
                avatarUrl={post.author_avatar_url}
                size="lg"
              />
              <div className="flex items-center gap-3 mt-4 flex-wrap">
                <Link
                  href={`/profile/${post.user_id}`}
                  className="text-xs text-indigo-400 hover:text-indigo-300 transition"
                >
                  查看 TA 的主页与更多作品 →
                </Link>
                {isOwn && (
                  <button
                    type="button"
                    onClick={() => void handleDeletePost()}
                    disabled={deleting}
                    className="text-xs text-zinc-600 hover:text-red-400 disabled:opacity-40 transition"
                  >
                    {deleting ? '删除中…' : '删除这篇'}
                  </button>
                )}
              </div>
            </section>

            {/* ── 正文 ── */}
            {isArchive ? (
              <ArchiveStory archive={post.archive!} />
            ) : (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-5">
                <p className="text-sm text-zinc-300 leading-loose whitespace-pre-wrap">
                  {post.content}
                </p>
                {post.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={post.image_url}
                    alt="配图"
                    className="mt-4 rounded-lg max-w-full border border-zinc-800"
                  />
                )}
              </div>
            )}

            {/* ── 标签 ── */}
            {post.tags && post.tags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {post.tags.map((t) => (
                  <span
                    key={t}
                    className="text-xs px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"
                  >
                    #{t}
                  </span>
                ))}
              </div>
            )}

            {/* ── 互动按钮 ── */}
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-4">
              <PostActionBar
                postId={post.id}
                liked={post.current_user_liked}
                saved={post.current_user_saved}
                likeCount={post.like_count}
                commentCount={post.comment_count}
                saveCount={post.save_count}
                busyLike={busy.has('like')}
                busySave={busy.has('save')}
                onToggleLike={() => void handleToggle('like')}
                onToggleSave={() => void handleToggle('save')}
              />
            </section>

            {/* ── 评论区 ── */}
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-5">
              <h2 className="text-sm font-medium text-zinc-200 mb-1">
                评论 {post.comment_count > 0 ? `· ${post.comment_count}` : ''}
              </h2>
              <CommentSection
                postId={post.id}
                token={token}
                viewerName={viewerName}
                viewerId={viewerId ?? undefined}
                onCommentAdded={() =>
                  setPost((prev) =>
                    prev ? { ...prev, comment_count: prev.comment_count + 1 } : prev
                  )
                }
                onCommentDeleted={(count) =>
                  setPost((prev) => (prev ? { ...prev, comment_count: count } : prev))
                }
              />
            </section>
          </article>
        )}
    </PageShell>
  )
}

/** 档案叙事主体 */
function ArchiveStory({ archive }: { archive: ArchiveSnapshot }) {
  const bp = archive.blueprintSummary
  const directionRows: Array<{ label: string; value: string }> = bp
    ? [
        { label: '主题定位', value: bp.positioning },
        { label: '目标观众', value: bp.audience },
        { label: '开头 Hook', value: bp.hook },
        { label: '核心冲突', value: bp.conflict },
        { label: '情绪曲线', value: bp.emotionCurve },
        { label: '叙述人格', value: bp.persona },
      ].filter((r) => r.value)
    : []

  return (
    <>
      {/* 1. 灵感起点 */}
      <section className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-6 py-5">
        <h2 className="text-sm font-semibold text-amber-200/90 mb-2">💡 灵感起点</h2>
        <p className="text-sm text-zinc-300 leading-loose whitespace-pre-wrap">
          {archive.inspiration}
        </p>
      </section>

      {/* 2. AI 创作方向（蓝图） */}
      {directionRows.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-5">
          <h2 className="text-sm font-semibold text-zinc-200 mb-3">
            🧭 AI 创作方向
            <span className="text-[11px] font-normal text-zinc-600 ml-2">
              基于灵感与风格画像生成的创作蓝图
            </span>
          </h2>
          <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
            {directionRows.map((r) => (
              <div key={r.label}>
                <dt className="text-[11px] text-zinc-500 mb-0.5">{r.label}</dt>
                <dd className="text-xs text-zinc-300 leading-relaxed">{r.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* 3. 版本变化记录 */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-5">
        <h2 className="text-sm font-semibold text-zinc-200 mb-4">
          🔄 版本变化记录
          <span className="text-[11px] font-normal text-zinc-600 ml-2">
            共 {archive.versions.length} 个版本
          </span>
        </h2>
        <ol className="relative space-y-4 before:absolute before:left-[7px] before:top-2 before:bottom-2 before:w-px before:bg-zinc-800">
          {archive.versions.map((v) => (
            <li key={v.n} className="relative pl-6">
              <span
                className={`absolute left-0 top-1.5 w-3.5 h-3.5 rounded-full border-2 ${
                  v.n === archive.finalVersionNumber
                    ? 'bg-emerald-500/80 border-emerald-400'
                    : 'bg-zinc-800 border-zinc-600'
                }`}
              />
              <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5">
                <span className="text-xs font-medium text-zinc-200">V{v.n}</span>
                {v.directionLabel ? (
                  <span className="text-[11px] text-indigo-300">
                    {v.directionEmoji} {v.directionLabel}迭代
                  </span>
                ) : (
                  <span className="text-[11px] text-zinc-500">初稿</span>
                )}
                {v.n === archive.finalVersionNumber && (
                  <span className="text-[10px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 rounded px-1.5 py-0.5">
                    最终版
                  </span>
                )}
              </div>
              {v.note && (
                <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
                  <span className="text-indigo-400/80">AI 修改说明：</span>
                  {v.note}
                </p>
              )}
              {v.n !== archive.finalVersionNumber && (
                <details className="mt-1 group">
                  <summary className="text-[11px] text-zinc-600 hover:text-zinc-400 cursor-pointer select-none list-none">
                    ▸ 查看该版片段
                  </summary>
                  <p className="mt-1.5 text-[11px] text-zinc-500 leading-relaxed border-l-2 border-zinc-800 pl-3">
                    {v.excerpt}
                  </p>
                </details>
              )}
            </li>
          ))}
        </ol>
      </section>

      {/* 4. 最终作品 */}
      <section className="rounded-xl border border-emerald-500/20 bg-zinc-900/40 px-6 py-5">
        <h2 className="text-sm font-semibold text-emerald-200/90 mb-3">
          ✍️ 最终作品
          <span className="text-[11px] font-normal text-zinc-600 ml-2">
            V{archive.finalVersionNumber}
          </span>
        </h2>
        <p className="text-sm text-zinc-200 leading-loose whitespace-pre-wrap">
          {archive.finalWork}
        </p>
      </section>

      {/* 5. 作者总结 */}
      {archive.authorSummary && (
        <section className="rounded-xl border border-indigo-500/25 bg-indigo-500/5 px-6 py-5">
          <h2 className="text-sm font-semibold text-indigo-200/90 mb-2">📝 作者总结</h2>
          <p className="text-sm text-zinc-300 leading-loose whitespace-pre-wrap">
            {archive.authorSummary}
          </p>
        </section>
      )}

      {archive.styleTags.length > 0 && (
        <p className="text-[11px] text-zinc-600">
          创作身份与风格：{archive.styleTags.join(' · ')}
        </p>
      )}
    </>
  )
}
