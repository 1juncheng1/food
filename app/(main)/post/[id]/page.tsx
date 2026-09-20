'use client'

// 帖子详情页（/post/[id]）
// moment：普通灵感正文 + 图片
// archive：完整创作档案叙事——灵感起点 → AI 创作方向 → 版本变化记录 → 最终作品 → 作者总结
// 档案展示的是发布瞬间的只读快照，与作品之后的迭代无关。

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
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
  image_url: string | null
  post_type: string
  archive: ArchiveSnapshot | null
  source_project_id: string | null
}

function formatTime(s: string): string {
  return new Date(s).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function PostDetailPage() {
  const params = useParams<{ id: string }>()
  const [post, setPost] = useState<PostDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) {
        setError('请先登录后查看')
        setLoading(false)
        return
      }
      const res = await fetch(`/api/posts/${params.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await res.json().catch(() => null)) as
        | { post?: PostDetail; error?: string }
        | null
      if (!res.ok || !data?.post) {
        setError(data?.error ?? '帖子不存在')
      } else {
        setPost(data.post)
      }
    } catch {
      setError('网络异常，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [params.id])

  useEffect(() => {
    if (params.id) void load()
  }, [params.id, load])

  const isArchive = post?.post_type === 'archive' && post.archive

  return (
    <div className="inner-page gen-stage" data-mode="inspiration">
      <Link
        href="/explore"
        className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition mb-6"
      >
        ← 返回灵感广场
      </Link>

      {loading && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-10 text-center text-sm text-zinc-500">
          加载中…
        </div>
      )}

      {error && !loading && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-10 text-center">
          <p className="text-sm text-red-300">{error}</p>
          <Link
            href="/explore"
            className="inline-block mt-4 text-xs text-indigo-400 hover:text-indigo-300"
          >
            回到灵感广场
          </Link>
        </div>
      )}

      {post && !loading && (
        <article className="space-y-6">
          {/* ── 通用头部 ── */}
          <header>
            {isArchive && (
              <span className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-indigo-500/15 text-indigo-300 border border-indigo-500/25 mb-3">
                📖 创作档案 · AI 协作全过程
              </span>
            )}
            <h1 className="text-xl font-bold text-zinc-100 leading-snug">
              {isArchive ? post.archive!.title : '灵感分享'}
            </h1>
            <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-3 text-xs text-zinc-500">
              <span className="text-zinc-300 font-medium">{post.author_name || '未知用户'}</span>
              <span>{formatTime(post.created_at)}</span>
              <span className="px-2 py-0.5 rounded bg-zinc-800/80 text-zinc-400">
                {post.category}
              </span>
            </div>
            {post.tags && post.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {post.tags.map((t) => (
                  <span key={t} className="text-[11px] text-zinc-500">
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </header>

          {/* ── 档案：创作故事 ── */}
          {isArchive ? (
            <ArchiveStory archive={post.archive!} />
          ) : (
            /* ── 普通灵感帖 ── */
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

          {/* ── 互动计数（互动操作在广场列表中进行） ── */}
          <footer className="flex items-center gap-5 text-xs text-zinc-600 pt-4 border-t border-zinc-800/70">
            <span>👍 {post.like_count}</span>
            <span>💬 {post.comment_count}</span>
            <span>⭐ {post.save_count}</span>
            <Link href="/explore" className="ml-auto text-indigo-400/80 hover:text-indigo-300">
              去广场互动 →
            </Link>
          </footer>
        </article>
      )}
    </div>
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
          <span className="text-[11px] font-normal text-zinc-600 ml-2">V{archive.finalVersionNumber}</span>
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
