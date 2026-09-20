'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { pickInspirationView, type InspirationApiRow } from '@/lib/creative/interest/inspirationView'

// ── 类型 ──

interface FeedCard {
  rec_id: string
  title: string
  description: string
  reason: string
  topic: string
  params: { category: string; topic: string; rec_id: string }
  slot: string
  cluster_code: string
  score: number
  score_breakdown: Record<string, number>
  evidence: Record<string, unknown>
  core_question?: string | null
  why_recommend?: string | null
  creation_angle?: string | null
  related_knowledge?: string[] | null
  reason_source?: string | null
  cross_exploration?: boolean
}

// ── 事件上报（复用 dashboard 模式，keepalive 保证跳转前发出，失败静默） ──

async function reportEvent(
  type: 'impression' | 'click' | 'dismiss',
  recId: string,
  token: string,
  keepalive = false
) {
  if (!recId || !token) return
  try {
    await fetch('/api/inspirations/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type, rec_id: recId }),
      keepalive,
    })
  } catch {
    // 网络异常静默
  }
}

// ── 页面 ──

export default function InspirationFeedPage() {
  const router = useRouter()
  const [cards, setCards] = useState<FeedCard[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [noMore, setNoMore] = useState(false)
  const [fallbackSource, setFallbackSource] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tokenRef = useRef<string | null>(null)
  const cursorRef = useRef<string | null>(null)
  const noMoreRef = useRef(false)
  const loadingMoreRef = useRef(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const cardRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  const impressedRef = useRef<Set<string>>(new Set())

  // ── 加载一页 ──
  const loadPage = useCallback(
    async (cur: string | null, isInitial = false) => {
      if (loadingMoreRef.current) return
      if (noMoreRef.current && !isInitial) return
      loadingMoreRef.current = true
      setLoadingMore(true)
      try {
        const params = new URLSearchParams({ limit: '10' })
        if (cur) params.set('cursor', cur)
        const res = await fetch(`/api/inspirations/feed?${params}`, {
          headers: tokenRef.current
            ? { Authorization: `Bearer ${tokenRef.current}` }
            : {},
        })
        if (!res.ok) {
          if (res.status === 401) {
            router.push('/login')
            return
          }
          throw new Error(`HTTP ${res.status}`)
        }
        const data = await res.json()
        const newCards = (data.cards ?? []) as FeedCard[]
        const nextCursor = data.next_cursor ?? null
        const nm = data.no_more === true
        const fs = data.fallback_source ?? null

        setCards((prev) => [...prev, ...newCards])
        cursorRef.current = nextCursor
        noMoreRef.current = nm
        setCursor(nextCursor)
        setNoMore(nm)
        setFallbackSource(fs)
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败')
      } finally {
        loadingMoreRef.current = false
        setLoadingMore(false)
        if (isInitial) setLoading(false)
      }
    },
    [router]
  )

  // ── 初始化 ──
  useEffect(() => {
    async function init() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.push('/login')
        return
      }
      tokenRef.current = session.access_token
      await loadPage(null, true)
    }
    init()
  }, [router, loadPage])

  // ── IntersectionObserver：卡片滑入视口报 impression ──
  useEffect(() => {
    if (!tokenRef.current || cards.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            const recId = entry.target.getAttribute('data-rec-id')
            if (recId && !impressedRef.current.has(recId)) {
              impressedRef.current.add(recId)
              void reportEvent('impression', recId, tokenRef.current!)
            }
          }
        }
      },
      { threshold: [0.5] }
    )

    // 观察所有未曝光的卡片
    cardRefs.current.forEach((el) => {
      if (el && el.getAttribute('data-rec-id')) {
        const recId = el.getAttribute('data-rec-id')!
        if (!impressedRef.current.has(recId)) {
          observer.observe(el)
        }
      }
    })

    return () => observer.disconnect()
  }, [cards])

  // ── IntersectionObserver：sentinel 触发加载下一页 ──
  useEffect(() => {
    if (!sentinelRef.current || noMoreRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingMoreRef.current) {
          void loadPage(cursorRef.current)
        }
      },
      { rootMargin: '200px' }
    )

    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [loadPage, cursor, noMore])

  // ── 交互 ──

  function handleClick(card: FeedCard) {
    if (!tokenRef.current) return
    // 个性化卡点击上报（keepalive 保证跳转前发出），热点卡 rec_id 无效不上报
    if (card.rec_id && !card.rec_id.startsWith('trending-')) {
      void reportEvent('click', card.rec_id, tokenRef.current, true)
    }
    router.push(
      `/generate?category=${encodeURIComponent(card.params.category)}&topic=${encodeURIComponent(card.params.topic)}&rec_id=${encodeURIComponent(card.rec_id)}`
    )
  }

  function handleDismiss(card: FeedCard, e: React.MouseEvent) {
    e.stopPropagation()
    if (!tokenRef.current || !card.rec_id) return
    if (!card.rec_id.startsWith('trending-')) {
      void reportEvent('dismiss', card.rec_id, tokenRef.current)
    }
    setCards((prev) => prev.filter((c) => c.rec_id !== card.rec_id))
  }

  // ── 渲染 ──

  if (loading) {
    return (
      <div className="flex h-[100dvh] items-center justify-center">
        <div className="text-zinc-400 animate-pulse">正在为你准备选题…</div>
      </div>
    )
  }

  if (error && cards.length === 0) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-4">
        <p className="text-zinc-400">加载失败：{error}</p>
        <button
          onClick={() => {
            setError(null)
            setLoading(true)
            void loadPage(null, true)
          }}
          className="rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
        >
          重试
        </button>
      </div>
    )
  }

  if (cards.length === 0 && noMore) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-3">
        <p className="text-lg text-zinc-300">今天的新选题先刷到这</p>
        <p className="text-sm text-zinc-500">明天再来，AI 会为你准备新的创作灵感</p>
        <Link
          href="/dashboard"
          className="mt-4 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
        >
          返回素材库
        </Link>
      </div>
    )
  }

  return (
    <div className="h-[100dvh] overflow-y-auto snap-y snap-mandatory bg-zinc-950">
      {cards.map((card) => {
        const view = pickInspirationView(card as InspirationApiRow)
        const isTrending = card.rec_id.startsWith('trending-')
        const isCross = card.cross_exploration === true
        return (
          <div
            key={card.rec_id}
            data-rec-id={card.rec_id}
            ref={(el) => {
              cardRefs.current.set(card.rec_id, el)
            }}
            className="snap-start flex min-h-[100dvh] items-center justify-center px-4 py-8"
          >
            <div
              onClick={() => handleClick(card)}
              className="clickable w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 backdrop-blur-sm transition hover:border-zinc-700 cursor-pointer"
            >
              {/* 标签行 */}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {isCross && (
                  <span className="rounded-full bg-purple-500/20 px-2 py-0.5 text-xs font-medium text-purple-300">
                    跨界灵感
                  </span>
                )}
                {isTrending ? (
                  <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-300">
                    大众热点
                  </span>
                ) : view.reasonSource === 'ai' ? (
                  <span className="rounded-full bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-300">
                    基于你的创作行为
                  </span>
                ) : (
                  <span className="rounded-full bg-zinc-700/50 px-2 py-0.5 text-xs font-medium text-zinc-400">
                    热门选题
                  </span>
                )}
              </div>

              {/* 标题 */}
              <h3 className="text-xl font-semibold leading-tight text-zinc-100">
                {view.title}
              </h3>

              {/* 描述 */}
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                {card.description}
              </p>

              {/* 核心问题（仅 AI 卡） */}
              {view.coreQuestion && (
                <p className="mt-3 text-sm text-zinc-300">
                  <span className="text-zinc-500">核心问题：</span>
                  {view.coreQuestion}
                </p>
              )}

              {/* 为什么适合你 */}
              <p className="mt-3 text-sm text-zinc-300">
                <span className="text-zinc-500">为什么适合你：</span>
                <span className={view.reasonSource === 'ai' ? '' : 'text-zinc-400'}>
                  {view.whyForYou}
                </span>
              </p>

              {/* 可以怎么创作 */}
              {view.creationAngle && (
                <p className="mt-2 text-sm text-zinc-300">
                  <span className="text-zinc-500">可以怎么创作：</span>
                  {view.creationAngle}
                </p>
              )}

              {/* 关联素材 */}
              {view.relatedKnowledge.length > 0 && (
                <p className="mt-2 text-xs text-zinc-400">
                  <span className="text-zinc-500">关联你的素材：</span>
                  {view.relatedKnowledge.join(' · ')}
                </p>
              )}

              {/* 操作行 */}
              <div className="mt-5 flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-200">
                  开始创作 →
                </span>
                <button
                  onClick={(e) => handleDismiss(card, e)}
                  title="不再推荐这类主题"
                  aria-label="不再推荐这类主题"
                  className="text-sm text-zinc-500 transition hover:text-red-400"
                >
                  不感兴趣 ✕
                </button>
              </div>
            </div>
          </div>
        )
      })}

      {/* 哨兵：进入视口触发加载下一页 */}
      {!noMore && (
        <div ref={sentinelRef} className="flex min-h-[100px] items-center justify-center">
          {loadingMore && (
            <span className="animate-pulse text-sm text-zinc-500">加载更多选题…</span>
          )}
        </div>
      )}

      {/* 末尾收尾 */}
      {noMore && cards.length > 0 && (
        <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3">
          <p className="text-lg text-zinc-300">今天的新选题先刷到这</p>
          <p className="text-sm text-zinc-500">明天再来，AI 会为你准备新的创作灵感</p>
          <Link
            href="/dashboard"
            className="mt-4 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            返回素材库
          </Link>
        </div>
      )}

      {/* 错误提示（非首次加载失败） */}
      {error && cards.length > 0 && (
        <div className="flex items-center justify-center py-4">
          <button
            onClick={() => {
              setError(null)
              void loadPage(cursorRef.current)
            }}
            className="text-sm text-zinc-400 hover:text-zinc-200"
          >
            加载失败，点击重试
          </button>
        </div>
      )}
    </div>
  )
}
