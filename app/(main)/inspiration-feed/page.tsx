'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getValidSession } from '@/lib/supabaseClient'
import { pickInspirationView, type InspirationApiRow } from '@/lib/creative/interest/inspirationView'
import { EmptyState, ErrorState } from '@/components/vision'

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
  /** P0 闭环：本轮新作品驱动生成的卡（服务端首屏前置） */
  fresh?: boolean
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
  /** 服务端正在重算画像/补卡：给用户一个"AI 正在重新理解你的新作品"的可见反馈 */
  const [building, setBuilding] = useState(false)
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
      // P2-1：路由切换时 abort 旧请求，避免旧响应覆盖新页面数据
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const params = new URLSearchParams({ limit: '10' })
        if (cur) params.set('cursor', cur)
        const res = await fetch(`/api/inspirations/feed?${params}`, {
          headers: tokenRef.current
            ? { Authorization: `Bearer ${tokenRef.current}` }
            : {},
          signal: controller.signal,
        })
        if (!res.ok) {
          // 只有真 401（确实没登录 / 登录确实过期）才跳登录页。
          //
          // 503 = 服务端那次网络抖动没能验完身份（见 lib/apiAuth.ts）。此时用户的
          // 登录态大概率仍然有效。若在这里把 503 也当成"没登录"处理，一次抖动就会
          // 把人踢到 /login——而 /login 的登录请求走的也是同一条网络，照样打不通，
          // 用户陷入「登不上、也回不去」的死结。抖动重试即可，不该由用户承担。
          if (res.status === 401) {
            router.push('/login')
            return
          }
          if (res.status === 503) {
            setError('网络不太稳定，下拉重试一次就好')
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
        // 只有首屏的 building 有意义：翻页请求的 building 属于"下一批"，
        // 提示条一直挂着反而误导
        if (isInitial) setBuilding(data.building === true)
      } catch (e) {
        // AbortError 静默：路由切换触发的取消是预期行为
        if (e instanceof Error && e.name === 'AbortError') return
        setError(e instanceof Error ? e.message : '加载失败')
      } finally {
        loadingMoreRef.current = false
        setLoadingMore(false)
        if (isInitial) setLoading(false)
      }
    },
    [router]
  )

  // P2-1：组件卸载时 abort 进行中的请求（防止旧响应覆盖新页面）
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  // ── 初始化 ──
  useEffect(() => {
    async function init() {
      // 必须走 getValidSession：裸调 getSession() 只读 localStorage 缓存、不刷新，
      // 页面停留超过 JWT 有效期后会拿到过期 token 直接 401（项目既定约定）
      const session = await getValidSession()
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
      <div className="h-[100dvh] overflow-y-auto snap-y snap-mandatory bg-zinc-950">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="snap-start flex min-h-[100dvh] items-center justify-center px-4 py-8"
          >
            <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
              <div className="mb-3 h-5 w-20 rounded-full bg-zinc-800 feed-skeleton" />
              <div className="h-6 w-3/4 rounded bg-zinc-800 feed-skeleton" />
              <div className="mt-3 h-4 w-full rounded bg-zinc-800/70 feed-skeleton" />
              <div className="mt-2 h-4 w-5/6 rounded bg-zinc-800/70 feed-skeleton" />
              <div className="mt-4 h-4 w-2/3 rounded bg-zinc-800/50 feed-skeleton" />
              <div className="mt-4 h-4 w-1/2 rounded bg-zinc-800/40 feed-skeleton" />
              <div className="mt-5 flex items-center justify-between">
                <div className="h-4 w-20 rounded bg-zinc-800/60 feed-skeleton" />
                <div className="h-4 w-24 rounded bg-zinc-800/60 feed-skeleton" />
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  // 灵感流是整屏吸附的信息流，不用 PageShell 包容器；
  // 但三态文案/样式统一走 vision 组件，保持全站一致的表达。
  if (error && cards.length === 0) {
    return (
      <div className="flex h-[100dvh] items-center justify-center px-6">
        <ErrorState
          message={`加载失败：${error}`}
          onRetry={() => {
            setError(null)
            setLoading(true)
            void loadPage(null, true)
          }}
        />
      </div>
    )
  }

  if (cards.length === 0 && noMore) {
    return (
      <div className="feed-end flex h-[100dvh] items-center justify-center px-6">
        <EmptyState
          title="今天的新选题先刷到这"
          description="明天再来，AI 会根据你今天的创作重新准备灵感。"
          actionLabel="回到创作机会"
          actionHref="/dashboard"
        />
      </div>
    )
  }

  return (
    <>
      {/* 重建提示：用固定浮层而非流内元素——容器是 snap-mandatory，
          插入非 snap-start 的流内节点会打乱整屏吸附 */}
      {building && (
        <div className="pointer-events-none fixed left-1/2 top-4 z-50 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/90 px-3 py-1.5 text-xs text-zinc-300 backdrop-blur-sm">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            AI 正在根据你最新的创作重新理解方向
          </div>
        </div>
      )}
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
              className="feed-card clickable w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 backdrop-blur-sm transition-all duration-300 hover:border-zinc-600 hover:bg-zinc-800/80 hover:scale-[1.02] cursor-pointer"
            >
              {/* 标签行 */}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {card.fresh && (
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-300">
                    承接你的新作品
                  </span>
                )}
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
        <div className="feed-end flex min-h-[100dvh] items-center justify-center px-6">
          <EmptyState
            title="今天的新选题先刷到这"
            description="明天再来，AI 会根据你今天的创作重新准备灵感。"
            actionLabel="回到创作机会"
            actionHref="/dashboard"
          />
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
    </>
  )
}
