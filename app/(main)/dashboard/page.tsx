'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowRight,
  Compass,
  Layers,
  Library,
  PenLine,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react'
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
import {
  AiStatus,
  CardLabel,
  EmptyState,
  PageHeader,
  PageShell,
  Section,
  SkeletonList,
  SkeletonText,
  StatRow,
  SurfaceCard,
  TagChip,
} from '@/components/vision'

/** 推荐卡内的一行「标签 → 内容」，保证四段信息结构一致 */
function InsightRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <dt className="w-[88px] shrink-0 pt-[1px] text-[12px] text-zinc-500">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-[13px] leading-relaxed text-zinc-300">
        {children}
      </dd>
    </div>
  )
}

const filterOptions = ['全部', ...CATEGORIES]

/** 兴趣画像（GET /api/creative/interest/profile）中本页用到的部分 */
interface InterestProfile {
  identity?: { completeness?: number; event_count_30d?: number }
  core?: { label?: string; weight?: number; trend?: string }[]
  exploration?: { label?: string; weight?: number; trend?: string }[]
  domains?: Record<string, number>
  recent_creation_direction?: { label: string; recentEvents: number } | null
}

/** 趋势枚举 → 中文（与 engine TrendDirection 对齐） */
const TREND_LABEL: Record<string, string> = {
  rising: '升温中',
  stable: '保持稳定',
  declining: '热度回落',
  dormant: '暂时沉寂',
}

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
  const [works, setWorks] = useState<GeneratedWork[]>([])
  const [worksLoading, setWorksLoading] = useState(true)
  const [filter, setFilter] = useState('全部')
  const [inspirations, setInspirations] = useState<Inspiration[]>([])
  const [inspLoading, setInspLoading] = useState(true)
  // 行为D：服务端有在途 build（首篇创作后画像重建中）时展示分析中提示，
  // 配合既有 20s 补拉轮询，build 完成后本标记随下次响应自动消失、换成个性化卡
  const [inspBuilding, setInspBuilding] = useState(false)
  // 「AI 正在理解你」区域数据源：兴趣画像（只读展示，失败静默降级为"还在认识你"）
  const [profile, setProfile] = useState<InterestProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
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

  // 兴趣画像：只用于「AI 正在理解你」展示，失败不影响任何主流程
  const loadProfile = useCallback(async () => {
    const token = inspTokenRef.current
    if (!token) {
      setProfileLoading(false)
      return
    }
    try {
      const res = await fetch('/api/creative/interest/profile', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        const p = data?.profile
        // 空对象 {} = 尚未建模，按无画像处理
        setProfile(p && Object.keys(p).length > 0 ? (p as InterestProfile) : null)
      }
    } catch {
      // 静默：画像只做展示
    } finally {
      setProfileLoading(false)
    }
  }, [])

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
      setWorks(getWorks())
      setWorksLoading(false)

      // 加载灵感推荐（失败不阻断页面）；未个性化则进入自动补拉轮询
      inspTokenRef.current = session?.access_token ?? null
      // 画像与灵感并行拉取：两者互不依赖，画像失败不影响卡片
      void loadProfile()
      const result = await loadInspirations()
      inspDoneRef.current = result?.personalized === true
      setInspLoading(false)
      if (!inspDoneRef.current) scheduleInspRetry()
    }
    init()
  }, [router, loadInspirations, scheduleInspRetry, loadProfile])

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

  // 「AI 正在理解你」三张卡的数据派生（全部来自兴趣画像，未建模时给出诚实说明）
  const coreLabels = (profile?.core ?? [])
    .map((c) => c.label)
    .filter((l): l is string => !!l)
  const domainTop = Object.entries(profile?.domains ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
  const rising = (profile?.core ?? []).filter((c) => c.trend === 'rising')
  const cooling = (profile?.core ?? []).filter(
    (c) => c.trend === 'declining' || c.trend === 'dormant'
  )

  return (
    <PageShell>
      <PageHeader
        eyebrow="创作机会"
        title="发现属于你的创作机会"
        description="AI 结合你的创作风格、知识积累与兴趣变化，为你挑出值得动手的方向。你写得越多、反馈越具体，它下一次就挑得越准。"
        actions={
          <Link
            href="/generate"
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500"
          >
            <PenLine size={15} />
            开始创作
          </Link>
        }
        ai={
          <AiStatus
            task="inspiration"
            active={inspLoading || inspBuilding}
            variant="bar"
          />
        }
      />

      {/* ── 沉淀条：让「积累」本身可见，而不是只有列表 ── */}
      <StatRow
        className="mb-9"
        items={[
          {
            label: '已完成的作品',
            value: worksLoading ? '—' : works.length,
          },
          {
            label: 'AI 识别的创作方向',
            value: profileLoading ? '—' : coreLabels.length,
          },
          {
            label: 'AI 对你的理解度',
            value: profile
              ? `${Math.round((profile.identity?.completeness ?? 0) * 100)}%`
              : '—',
            hint: profile ? undefined : '创作几篇后开始建模',
          },
          {
            label: '近 30 天创作行为',
            value: profile?.identity?.event_count_30d ?? '—',
          },
        ]}
      />

      {/* ── AI 分析区域：明确告诉用户 AI 正在理解什么 ── */}
      <Section
        eyebrow="AI 正在理解"
        title="它现在是这样认识你的"
        description="下面的判断来自你的创作、修改与反馈记录，也是它挑选机会的依据。"
        className="mb-10"
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <SurfaceCard className="flex flex-col gap-2.5">
            <CardLabel icon={<Compass size={13} />}>我的创作方向</CardLabel>
            {profileLoading ? (
              <SkeletonText lines={2} />
            ) : profile ? (
              <>
                <p className="text-[15px] font-medium leading-snug text-zinc-100">
                  {profile.recent_creation_direction?.label ?? coreLabels[0] ?? '还在观察你的创作'}
                </p>
                <p className="text-[12px] leading-relaxed text-zinc-500">
                  {profile.recent_creation_direction
                    ? `近 7 天有 ${profile.recent_creation_direction.recentEvents} 次相关创作行为`
                    : '继续创作，AI 会更快锁定你的主线方向'}
                </p>
                {coreLabels.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    {coreLabels.slice(0, 3).map((l) => (
                      <TagChip key={l} tone="brand" size="sm">
                        {l}
                      </TagChip>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-[13px] leading-relaxed text-zinc-500">
                还没有足够的创作记录。完成第一篇作品后，这里会出现 AI 对你方向的判断。
              </p>
            )}
          </SurfaceCard>

          <SurfaceCard className="flex flex-col gap-2.5">
            <CardLabel icon={<Library size={13} />}>我的知识领域</CardLabel>
            {profileLoading ? (
              <SkeletonText lines={2} />
            ) : domainTop.length > 0 ? (
              <>
                <p className="text-[15px] font-medium leading-snug text-zinc-100">
                  {domainTop[0][0]}
                </p>
                <div className="mt-0.5 flex flex-wrap gap-1.5">
                  {domainTop.map(([name, ratio]) => (
                    <TagChip key={name} size="sm">
                      {name} {Math.round(ratio * 100)}%
                    </TagChip>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-[13px] leading-relaxed text-zinc-500">
                沉淀素材与作品后，AI 会归纳出你真正擅长的知识领域。
              </p>
            )}
          </SurfaceCard>

          <SurfaceCard className="flex flex-col gap-2.5">
            <CardLabel icon={<TrendingUp size={13} />}>我的兴趣变化</CardLabel>
            {profileLoading ? (
              <SkeletonText lines={2} />
            ) : profile ? (
              <>
                {rising.length > 0 ? (
                  <p className="text-[15px] font-medium leading-snug text-zinc-100">
                    {rising[0].label} {TREND_LABEL[rising[0].trend ?? ''] ?? ''}
                  </p>
                ) : (
                  <p className="text-[15px] font-medium leading-snug text-zinc-100">
                    兴趣结构保持稳定
                  </p>
                )}
                <div className="mt-0.5 flex flex-wrap gap-1.5">
                  {rising.slice(0, 2).map((c) => (
                    <TagChip key={`r-${c.label}`} tone="accent" size="sm">
                      ↑ {c.label}
                    </TagChip>
                  ))}
                  {cooling.slice(0, 2).map((c) => (
                    <TagChip key={`c-${c.label}`} tone="muted" size="sm">
                      ↓ {c.label}
                    </TagChip>
                  ))}
                </div>
                <p className="text-[12px] leading-relaxed text-zinc-500">
                  AI 会据此决定：继续深挖，还是给你换个新方向。
                </p>
              </>
            ) : (
              <p className="text-[13px] leading-relaxed text-zinc-500">
                AI 还在观察你的兴趣走向，暂时不会凭单次行为下结论。
              </p>
            )}
          </SurfaceCard>
        </div>
      </Section>

      {/* ── 核心功能区：AI 找到的创作机会 ── */}
      <Section
        eyebrow="为你挑选"
        title="AI 找到的创作机会"
        description="每张卡都带着推荐理由、可切入的角度和它参考的你的知识。"
        actions={
          <Link
            href="/inspiration-feed"
            className="inline-flex items-center gap-1.5 rounded-xl border border-white/[0.1] px-3.5 py-2 text-[13px] font-medium text-zinc-300 transition hover:border-white/20 hover:text-white"
          >
            看更多灵感
            <ArrowRight size={14} />
          </Link>
        }
        className="mb-10"
      >
        {/* 首篇创作后画像重建中：明确告知 AI 正在做什么，完成后随轮询自动换卡 */}
        {!inspLoading && inspBuilding && (
          <AiStatus
            task="inspiration"
            active
            variant="steps"
            className="mb-3"
          />
        )}

        {inspLoading ? (
          <SkeletonList count={3} height={148} />
        ) : inspirations.length === 0 ? (
          <EmptyState
            icon={<Sparkles size={18} />}
            title="AI 还没开始为你挑选"
            description="它需要一点创作记录才能理解你的方向。完成第一篇作品后，这里会出现只属于你的机会。"
            actionLabel="开始第一次创作"
            actionHref="/generate"
            secondaryLabel="去看看大家在创作什么"
            secondaryHref="/explore"
          />
        ) : (
          <div className="flex flex-col gap-3">
            {inspirations.map((ins, idx) => {
              // WF7：三段式视图（AI 理由优先，旧卡/模板卡回退模板 reason）
              const view = pickInspirationView(ins)
              const isAi = view.reasonSource === 'ai'
              return (
                <SurfaceCard
                  key={ins.rec_id ?? `tpl-${idx}`}
                  interactive
                  className="group"
                  onClick={() => {
                    // WF1：个性化卡点击 = recommend_click（keepalive 保证跳转前发出）
                    // 并透传 rec_id 到 /generate，方案生成成功后回流 recommend_adopt
                    if (ins.rec_id) void reportRecEvent('click', ins.rec_id, true)
                    const recParam = ins.rec_id ? `&rec_id=${encodeURIComponent(ins.rec_id)}` : ''
                    router.push(
                      `/generate?category=${encodeURIComponent(ins.params.category)}&topic=${encodeURIComponent(ins.params.topic)}${recParam}`
                    )
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <TagChip
                          tone={isAi ? 'brand' : 'neutral'}
                          size="sm"
                          icon={<Sparkles size={11} />}
                        >
                          {isAi ? 'AI 为你挑选' : '大众创作方向'}
                        </TagChip>
                        {ins.cross_exploration && (
                          <TagChip tone="violet" size="sm">
                            跨界灵感
                          </TagChip>
                        )}
                      </div>

                      <h3 className="mt-2.5 text-[16px] font-semibold leading-snug text-white">
                        {view.title}
                      </h3>
                      <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-400 line-clamp-2">
                        {ins.description}
                      </p>

                      <div className="vs-divider my-3.5" />

                      <dl className="space-y-2">
                        <InsightRow label="为什么推荐给你">
                          <span className={isAi ? 'text-zinc-200' : 'text-zinc-400'}>
                            {view.whyForYou}
                          </span>
                        </InsightRow>
                        {view.coreQuestion && (
                          <InsightRow label="可能的方向">
                            {view.coreQuestion}
                          </InsightRow>
                        )}
                        {view.creationAngle && (
                          <InsightRow label="创作角度">
                            {view.creationAngle}
                          </InsightRow>
                        )}
                        {view.relatedKnowledge.length > 0 && (
                          <InsightRow label="相关知识">
                            <span className="flex flex-wrap gap-1.5">
                              {view.relatedKnowledge.map((k) => (
                                <TagChip key={k} size="sm">
                                  {k}
                                </TagChip>
                              ))}
                            </span>
                          </InsightRow>
                        )}
                      </dl>

                      <div className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-indigo-300">
                        用这个方向开始创作
                        <ArrowRight
                          size={14}
                          className="transition-transform duration-200 group-hover:translate-x-0.5"
                        />
                      </div>
                    </div>

                    {ins.rec_id && (
                      <button
                        onClick={(e) => handleDismissInsp(ins, e)}
                        title="不再推荐这类主题"
                        aria-label="不再推荐这类主题"
                        className="shrink-0 rounded-lg p-1.5 text-zinc-600 transition hover:bg-red-500/10 hover:text-red-300"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </SurfaceCard>
              )
            })}
          </div>
        )}
      </Section>

      {/* ── 沉淀区：我的作品（历史作品入口，详细成长档案见 /works） ── */}
      <Section
        eyebrow="沉淀"
        title="我的作品"
        description="每一篇作品与每次修改，都会成为 AI 理解你的依据。"
        actions={
          <div className="flex items-center gap-2.5">
            {!worksLoading && (
              <span className="text-[12px] text-zinc-500">共 {works.length} 篇</span>
            )}
            <Link
              href="/works"
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/[0.1] px-3.5 py-2 text-[13px] font-medium text-zinc-300 transition hover:border-white/20 hover:text-white"
            >
              成长档案
              <ArrowRight size={14} />
            </Link>
          </div>
        }
      >
        {/* 分类筛选：只作用于作品列表 */}
        <div className="mb-4 flex flex-wrap gap-1.5">
          {filterOptions.map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                filter === cat
                  ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-300'
                  : 'border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-zinc-200'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {worksLoading ? (
          <SkeletonList count={3} height={76} />
        ) : filteredWorks.length === 0 ? (
          <EmptyState
            icon={<PenLine size={18} />}
            title={filter === '全部' ? '还没有作品' : `暂无「${filter}」分类的作品`}
            description="开始第一次创作，AI 会逐渐了解你的表达方式与关注领域。"
            actionLabel="开始第一次创作"
            actionHref="/generate"
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {filteredWorks.map((w) => (
              <SurfaceCard
                key={w.id}
                interactive
                padded={false}
                className="px-5 py-4"
                onClick={() => {
                  // 跳转前记录精确位置与筛选，返回（popstate）后据此恢复
                  saveDashboardState(window.scrollY, filter)
                  // 第三阶段：作品统一进入创作空间 /article（版本/诊断/迭代），
                  // /works/[id] 仅作为老链接的重定向兼容层保留
                  router.push(`/article/${w.id}`)
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[15px] font-semibold leading-snug text-white line-clamp-1">
                      {w.title}
                    </h3>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {w.solution && (
                        <TagChip size="sm" tone="accent">
                          问题求解
                        </TagChip>
                      )}
                      <TagChip size="sm">{w.category}</TagChip>
                      {w.identityLabel && (
                        <TagChip size="sm" tone="muted">
                          {w.identityLabel.length > 24
                            ? `${w.identityLabel.slice(0, 24)}…`
                            : w.identityLabel}
                        </TagChip>
                      )}
                      <span className="text-[11px] text-zinc-600">
                        {new Date(w.created_at).toLocaleDateString('zh-CN')}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={(e) => handleDeleteWork(w, e)}
                    className="shrink-0 rounded-lg border border-white/[0.08] px-2 py-1 text-[12px] text-zinc-500 transition hover:border-red-500/40 hover:text-red-300"
                  >
                    删除
                  </button>
                </div>
              </SurfaceCard>
            ))}
          </div>
        )}
      </Section>

      {/* ── 让 AI 更懂你：素材 / 知识 / 理解报告入口 ── */}
      <Section eyebrow="让它更懂你" title="继续积累你的创作资产" className="mt-10">
        <div className="grid gap-3 sm:grid-cols-3">
          <Link href="/materials" className="block">
            <SurfaceCard interactive className="h-full">
              <div className="flex items-start gap-3">
                <span className="text-indigo-300/80">
                  <Layers size={16} />
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-zinc-100">我的素材</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
                    原始文案与资料，AI 理解的起点
                  </p>
                </div>
              </div>
            </SurfaceCard>
          </Link>
          <Link href="/knowledge" className="block">
            <SurfaceCard interactive className="h-full">
              <div className="flex items-start gap-3">
                <span className="text-emerald-300/80">
                  <Library size={16} />
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-zinc-100">知识库</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
                    从素材沉淀出的可复用观点
                  </p>
                </div>
              </div>
            </SurfaceCard>
          </Link>
          <Link href="/style-profile" className="block">
            <SurfaceCard interactive className="h-full">
              <div className="flex items-start gap-3">
                <span className="text-violet-300/80">
                  <Sparkles size={16} />
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-zinc-100">AI 理解报告</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
                    看看 AI 现在是怎么理解你的
                  </p>
                </div>
              </div>
            </SurfaceCard>
          </Link>
        </div>
      </Section>
    </PageShell>
  )
}
