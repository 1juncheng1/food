'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { CATEGORIES } from '@/lib/constants'
import { pickInspirationView } from '@/lib/creative/interest/inspirationView'
import { getWorks, deleteWork, type GeneratedWork } from '@/lib/works'
import {
  saveDashboardState,
  consumeReturnNavigation,
  restoreDashboardScroll,
  type DashboardScrollState,
} from '@/lib/scrollMemory'

const filterOptions = ['全部', ...CATEGORIES]

/** 灵感推荐数据结构（rec_id 仅个性化卡有，模板卡缺失；五字段为 WF6 AI 理由，旧卡为 null） */
interface Inspiration {
  title: string
  description: string
  reason: string
  params: { category: string; topic: string }
  rec_id?: string
  why_recommend?: string | null
  creation_angle?: string | null
  core_question?: string | null
  related_knowledge?: string[] | null
  reason_source?: string | null
  /** WF11 P2：跨界灵感标记（evidence.cross_exploration） */
  cross_exploration?: boolean
}

export default function DashboardPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [works, setWorks] = useState<GeneratedWork[]>([])
  const [worksLoading, setWorksLoading] = useState(true)
  const [filter, setFilter] = useState('全部')
  const [inspirations, setInspirations] = useState<Inspiration[]>([])
  const [inspLoading, setInspLoading] = useState(true)
  // 行为D：服务端有在途 build（首篇创作后画像重建中）时展示分析中提示，
  // 配合既有 20s 补拉轮询，build 完成后本标记随下次响应自动消失、换成个性化卡
  const [inspBuilding, setInspBuilding] = useState(false)
  // 灵感推荐自动补拉：build 是 fire-and-forget（30-60s），首次进页若未个性化
  // （新用户首建中/画像重建中），需轮询补拉让卡片在当前页面自动刷新，而非要求手动二次刷新
  const inspTokenRef = useRef<string | null>(null)
  const inspDoneRef = useRef(false)
  const inspRetryRef = useRef(0)
  const inspTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 删除作品成功后触发服务端增量重建（约 30-60s）；此定时器驱动"轮询至推荐内容变化"
  // 的补拉——build 完成前旧队列仍 active，单次延迟补拉可能拿到的还是旧卡
  const inspRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 返回素材库时待恢复的滚动记忆（仅 popstate 后的挂载有值）；筛选同步用 ref 供 pagehide 兜底
  const pendingRestoreRef = useRef<DashboardScrollState | null>(null)
  const filterRef = useRef(filter)
  useEffect(() => {
    // 在 effect 中同步 ref（不在渲染期写 ref），供 pagehide 兜底读取最新筛选
    filterRef.current = filter
  }, [filter])

  // WF1 推荐反馈上报：曝光/点击/✕。失败静默不重试，绝不影响主流程。
  const reportRecEvent = useCallback(async (type: 'impression' | 'click' | 'dismiss', recId: string, keepalive = false) => {
    const token = inspTokenRef.current
    if (!token || !recId) return
    try {
      await fetch('/api/inspirations/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type, rec_id: recId }),
        keepalive,
      })
    } catch {
      // 网络异常静默：反馈丢失可接受，不阻塞浏览
    }
  }, [])

  // 返回 null=请求失败/无数据；否则返回个性化标记、build 在途标记与本次拉到的卡片列表。
  // items 一并返回：删除作品后的补拉需要对比"删除前快照"判断队列是否已更新。
  const loadInspirations = useCallback(async (): Promise<{ personalized: boolean; building: boolean; items: Inspiration[] } | null> => {
    const token = inspTokenRef.current
    try {
      const res = await fetch('/api/inspirations', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data.inspirations)) {
          const items = data.inspirations as Inspiration[]
          setInspirations(items)
          setInspBuilding(data.building === true)
          // WF1：个性化卡逐张上报曝光（按天幂等，重复刷新被服务端吞掉）
          if (data.personalized === true) {
            items.forEach((it) => {
              if (it.rec_id) void reportRecEvent('impression', it.rec_id)
            })
          }
          return { personalized: data.personalized === true, building: data.building === true, items }
        }
      }
    } catch {
      // 网络异常，灵感区静默降级为空
    }
    return null
  }, [reportRecEvent])

  const scheduleInspRetry = useCallback(() => {
    // build 窗口：并发补算后通常 30-90s（embedding 补齐 + 3 次 LLM 串行）。
    // 每 10s 补拉一次，最多 12 次（120s），拿到个性化结果即停。
    // （WF10 实测旧窗口 20s×5=100s 被一个 146s 的 build 超过，轮询先停、卡永不出现）
    // attempt 是闭包内具名函数（自递归），避免 useCallback 自引用的声明前访问问题
    function attempt() {
      if (inspDoneRef.current || !inspTokenRef.current || inspRetryRef.current >= 12) return
      inspRetryRef.current += 1
      void loadInspirations().then((r) => {
        if (r?.personalized) inspDoneRef.current = true
        else inspTimerRef.current = setTimeout(attempt, 10_000)
      })
    }
    if (inspDoneRef.current || !inspTokenRef.current) return
    if (inspTimerRef.current) clearTimeout(inspTimerRef.current)
    inspTimerRef.current = setTimeout(attempt, 10_000)
  }, [loadInspirations])

  // 删除作品后的推荐补拉：轮询直到返回内容与删除前快照不同（拿到重建后的新队列）
  // 或达上限。不能只看 personalized 标记——删除前后它都是 true（旧队列在 build 完成
  // 前仍是 active 卡），必须对比内容本身。20s × 6 次 = 120s，覆盖增量重建 30-60s 完成窗口。
  const scheduleInspRefreshAfterDelete = useCallback(() => {
    const before = JSON.stringify(inspirations)
    let attempts = 0
    function attempt() {
      if (attempts >= 6) return
      attempts += 1
      void loadInspirations().then((r) => {
        // r=null（请求失败）或内容未变（build 尚未完成/删除确实不影响推荐）→ 继续轮询；
        // 内容已变化（拿到重建后的新队列）→ 停止
        if (!r || JSON.stringify(r.items) === before) {
          inspRefreshTimerRef.current = setTimeout(attempt, 20_000)
        }
      })
    }
    if (inspRefreshTimerRef.current) clearTimeout(inspRefreshTimerRef.current)
    inspRefreshTimerRef.current = setTimeout(attempt, 20_000)
  }, [loadInspirations, inspirations])

  // 回到页面（切标签/切窗口）时若尚未个性化，立即补拉一次，缩短感知延迟
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState !== 'visible') return
      if (inspDoneRef.current || !inspTokenRef.current) return
      loadInspirations().then((r) => {
        if (r?.personalized) inspDoneRef.current = true
      })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (inspTimerRef.current) clearTimeout(inspTimerRef.current)
      if (inspRefreshTimerRef.current) clearTimeout(inspRefreshTimerRef.current)
    }
  }, [loadInspirations])

  useEffect(() => {
    // 必须在任何异步/渲染前判定：本次挂载是否为「详情页返回（popstate）」。
    // 是则先恢复筛选，保证列表按原分类渲染（高度与离开时一致），滚动随后精确恢复。
    const { restore, state } = consumeReturnNavigation()
    if (restore && state) {
      pendingRestoreRef.current = state
      setFilter(state.filter)
    }

    async function init() {
      // 游客可进入（AuthGuard 白名单 + 首页「立即开始」直达）：
      // 作品列表走 localStorage 与登录态无关；灵感区无 token 时接口降级为平台推荐
      const { data: { session } } = await supabase.auth.getSession()
      setEmail(session?.user.email ?? '游客模式')
      setWorks(getWorks())
      setWorksLoading(false)

      // 加载灵感推荐（失败不阻断页面）；未个性化则进入自动补拉轮询
      inspTokenRef.current = session?.access_token ?? null
      const result = await loadInspirations()
      inspDoneRef.current = result?.personalized === true
      setInspLoading(false)
      if (!inspDoneRef.current) scheduleInspRetry()
    }
    init()
  }, [router, loadInspirations, scheduleInspRetry])

  // 列表真实 DOM 提交后再恢复滚动：骨架屏阶段页面高度不足，恢复会被钳制为 0。
  // rAF 循环每帧按最新 scrollHeight 重算上限，直到列表高度足以承载目标 scrollTop。
  useEffect(() => {
    if (worksLoading || !pendingRestoreRef.current) return
    const target = pendingRestoreRef.current
    const cancel = restoreDashboardScroll(target.y)
    pendingRestoreRef.current = null
    return cancel
  }, [worksLoading])

  // 兜底：页面被隐藏（浏览器跳转/关闭）时再存一次当前位置，防止非卡片点击的跳转路径丢失位置
  useEffect(() => {
    function onPageHide() {
      saveDashboardState(window.scrollY, filterRef.current)
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [])

  // P2-3：进入 dashboard 后台预取灵感推荐页路由（用户高概率下一步进入）
  useEffect(() => {
    router.prefetch('/inspiration-feed')
  }, [router])

  async function handleDeleteWork(work: GeneratedWork, e: React.MouseEvent) {
    e.stopPropagation()
    const id = work.id
    if (
      !confirm(
        work.projectId
          ? '确定要删除这个作品吗？将同时删除其云端全部历史版本，删除后不可恢复'
          : '确定要删除这个作品吗？删除后不可恢复'
      )
    )
      return
    // 本地始终先删，保证列表即时响应（游客作品本就只在 localStorage）
    deleteWork(id)
    setWorks((prev) => prev.filter((w) => w.id !== id))

    // 登录用户同步硬删除服务端记录，避免"幽灵作品"永久污染兴趣画像；
    // 任何失败都不回滚本地删除（与既有"本地为准"的宽松行为一致）
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      // 项目作品必须走项目级删除：本地 id 是 uuid ≠ 服务端版本行 id（{projectId}::vN），
      // 旧路径 DELETE /works/{uuid} 必然 404 且版本行受 409 保护，云端永远删不掉；
      // 无 projectId 的老作品才走单作品删除
      const url = work.projectId
        ? `/api/creative/projects/${encodeURIComponent(work.projectId)}`
        : `/api/creative/works/${encodeURIComponent(id)}`
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        // 服务端删除已触发增量重建（约 30-60s 完成）：轮询补拉直到推荐内容
        // 反映删除结果（或达 120s 上限），无需用户手动刷新
        scheduleInspRefreshAfterDelete()
      } else {
        // 404=服务端无此行（老数据/游客补登录的幽灵）；409/其他=真实失败，仅记日志
        console.warn('作品服务端删除失败:', res.status)
      }
    } catch {
      // 网络异常静默：本地已删，下次删除其他作品不影响
    }
  }

  // WF1：✕ 不感兴趣——卡片立即离场（乐观更新），服务端记 -1.5 负反馈并触发
  // 增量重建，下次进页该主题的推荐显著减少
  function handleDismissInsp(ins: Inspiration, e: React.MouseEvent) {
    e.stopPropagation()
    if (!ins.rec_id) return
    void reportRecEvent('dismiss', ins.rec_id)
    setInspirations((prev) => prev.filter((x) => x.rec_id !== ins.rec_id))
  }

  const filteredWorks =
    filter === '全部' ? works : works.filter((w) => w.category === filter)

  return (
    <div className="inner-page gen-stage" data-mode="inspiration">
      <div className="inner-container">
        {/* ── 顶部：标题（退出按钮已由 Sidebar 统一提供）── */}
        <div className="inner-header">
          <div>
            <h1 className="inner-header-title">我的素材库</h1>
            <p className="inner-header-sub">{email}</p>
          </div>
        </div>

        {/* ── 功能入口：两张卡片式按钮 ── */}
        <div className="inner-actions">
          <Link href="/materials" className="inner-action-card">
            <div className="inner-action-icon indigo">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h16M4 12h16M4 18h10" />
              </svg>
            </div>
            <div>
              <div className="inner-action-title">素材库</div>
              <div className="inner-action-desc">管理原始文案，建立你的风格库</div>
            </div>
          </Link>
          <Link href="/generate" className="inner-action-card">
            <div className="inner-action-icon emerald">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <div>
              <div className="inner-action-title">新建生成任务</div>
              <div className="inner-action-desc">AI 学习你的风格，快速生成解说</div>
            </div>
          </Link>
        </div>

        {/* ── 风格卡入口 ── */}
        <Link href="/style-profile" className="inner-action-card" style={{ marginBottom: '40px' }}>
          <div className="inner-action-icon" style={{ background: 'rgba(168,85,247,0.15)', color: '#c084fc' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7l9-4 9 4-9 4-9-4z" />
              <path d="M3 12l9 4 9-4M3 17l9 4 9-4" />
            </svg>
          </div>
          <div>
            <div className="inner-action-title">我的风格卡</div>
            <div className="inner-action-desc">查看你的创作风格特征与语气偏好</div>
          </div>
        </Link>

        {/* ── 分类筛选 ── */}
        <div className="inner-filter-bar">
          {filterOptions.map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={`inner-filter-chip ${filter === cat ? 'active' : ''}`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* ── AI 发现的创作机会（置于作品列表之上，优先激发创作） ── */}
        <div className="inner-section-head">
          <h2 className="inner-section-title">AI 发现的创作机会</h2>
        </div>

        {/* 行为D：首篇创作后画像重建中（building 由 /api/inspirations 依据在途 build 返回，
            完成后随既有 20s 轮询自动换卡，无需手动刷新） */}
        {!inspLoading && inspBuilding && (
          <div className="inner-list" style={{ marginBottom: '12px' }}>
            <div
              className="inner-item"
              style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 16px' }}
            >
              <span className="animate-pulse" aria-hidden>✨</span>
              <span className="text-sm text-zinc-400">
                正在分析你的第一篇创作，为你定制的选题马上就来…
              </span>
            </div>
          </div>
        )}

        {inspLoading ? (
          <div className="inner-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="inner-item" style={{ height: 88 }} />
            ))}
          </div>
        ) : inspirations.length > 0 ? (
          <div className="inner-list">
            {inspirations.map((ins, idx) => {
              // WF7：三段式视图（AI 理由优先，旧卡/模板卡回退模板 reason）
              const view = pickInspirationView(ins)
              return (
              <div
                key={ins.rec_id ?? `tpl-${idx}`}
                onClick={() => {
                  // WF1：个性化卡点击 = recommend_click（keepalive 保证跳转前发出）
                  // 并透传 rec_id 到 /generate，方案生成成功后回流 recommend_adopt
                  if (ins.rec_id) void reportRecEvent('click', ins.rec_id, true)
                  const recParam = ins.rec_id ? `&rec_id=${encodeURIComponent(ins.rec_id)}` : ''
                  router.push(
                    `/generate?category=${encodeURIComponent(ins.params.category)}&topic=${encodeURIComponent(ins.params.topic)}${recParam}`
                  )
                }}
                className="inner-item clickable"
              >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h3 className="inner-item-title">{view.title}</h3>
                  <p className="text-sm text-zinc-500 mt-1 line-clamp-2">{ins.description}</p>
                  {view.coreQuestion && (
                    <p className="text-sm text-zinc-600 mt-2">
                      <span className="text-zinc-400">核心问题：</span>{view.coreQuestion}
                    </p>
                  )}
                  <p className="text-sm text-zinc-600 mt-2">
                    <span className="text-zinc-400">为什么适合你：</span>
                    <span className={view.reasonSource === 'ai' ? '' : 'text-zinc-400'}>{view.whyForYou}</span>
                  </p>
                  {view.creationAngle && (
                    <p className="text-sm text-zinc-600 mt-1.5">
                      <span className="text-zinc-400">可以怎么创作：</span>{view.creationAngle}
                    </p>
                  )}
                  {view.relatedKnowledge.length > 0 && (
                    <p className="text-xs text-zinc-500 mt-1.5">
                      <span className="text-zinc-400">关联你的素材：</span>
                      {view.relatedKnowledge.join(' · ')}
                    </p>
                  )}
                  <span className="inner-item-tag" style={{ marginTop: '8px', display: 'inline-block' }}>
                    {view.reasonSource === 'ai' ? '基于你的创作行为' : '大众创作方向'}
                  </span>
                  {ins.cross_exploration && (
                    <span
                      className="ml-2 inline-block rounded-full bg-purple-500/20 px-2 py-0.5 text-xs font-medium text-purple-300"
                      style={{ marginTop: '8px' }}
                    >
                      跨界灵感
                    </span>
                  )}
                </div>
                <svg className="shrink-0 text-zinc-600 mt-1" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
                {ins.rec_id && (
                  <button
                    onClick={(e) => handleDismissInsp(ins, e)}
                    title="不再推荐这类主题"
                    aria-label="不再推荐这类主题"
                    className="shrink-0 mt-1 text-zinc-500 hover:text-red-400 transition text-base leading-none"
                  >
                    ✕
                  </button>
                )}
              </div>
              </div>
              )
            })}
          </div>
        ) : (
          <div className="inner-empty">
            <p>暂无灵感推荐</p>
            <p className="sub">多生成几篇作品后，系统会根据你的偏好推荐选题</p>
          </div>
        )}

        {/* WF11 P2：看更多灵感入口 → 全屏竖滑 Feed */}
        {inspirations.length > 0 && (
          <div className="mt-3 flex justify-center">
            <Link
              href="/inspiration-feed"
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/50 px-4 py-2 text-sm text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-800"
            >
              看更多灵感
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c-1.5-1.5-2-4.5-2-9s.5-7.5 2-9M3 12a9 9 0 0 1 9-9" />
              </svg>
            </Link>
          </div>
        )}

        {/* ── 区块标题 + 计数 ── */}
        <div className="inner-section-head" style={{ marginTop: '48px' }}>
          <h2 className="inner-section-title">生成作品</h2>
          {!worksLoading && (
            <span className="inner-section-count">共 {works.length} 篇</span>
          )}
        </div>

        {/* ── 作品列表 ── */}
        {worksLoading ? (
          <div className="inner-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="inner-item" style={{ height: 72 }} />
            ))}
          </div>
        ) : filteredWorks.length === 0 ? (
          <div className="inner-empty">
            <p>
              {filter === '全部' ? '还没有生成作品' : `暂无「${filter}」分类的作品`}
            </p>
            <p className="sub">点击上方「新建生成任务」，AI 将基于你的素材库进行创作</p>
          </div>
        ) : (
          <div className="inner-list">
            {filteredWorks.map((w) => (
              <div
                key={w.id}
                onClick={() => {
                  // 跳转前记录精确位置与筛选，返回（popstate）后据此恢复
                  saveDashboardState(window.scrollY, filter)
                  // 第三阶段：作品统一进入创作空间 /article（版本/诊断/迭代），
                  // /works/[id] 仅作为老链接的重定向兼容层保留
                  router.push(`/article/${w.id}`)
                }}
                className="inner-item clickable"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="inner-item-title">{w.title}</h3>
                    <div className="inner-item-meta">
                      {w.solution && <span className="inner-item-tag">问题求解</span>}
                      <span className="inner-item-tag">{w.category}</span>
                      {w.identityLabel && (
                        <span className="inner-item-tag">
                          {w.identityLabel.length > 24 ? `${w.identityLabel.slice(0, 24)}…` : w.identityLabel}
                        </span>
                      )}
                      <span className="inner-item-date">
                        {new Date(w.created_at).toLocaleDateString('zh-CN')}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={(e) => handleDeleteWork(w, e)}
                    className="text-xs text-zinc-600 hover:text-red-400 transition shrink-0"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 右下角浮动：添加素材快捷入口
      <Link href="/add" className="inner-fab">
        <span className="inner-fab-label">添加素材</span>
        <span className="inner-fab-plus">+</span>
      </Link> */}
    </div>
  )
}
