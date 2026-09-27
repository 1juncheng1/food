'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getValidSession } from '@/lib/supabaseClient'
import { RefreshCw } from 'lucide-react'
import {
  KNOWLEDGE_STATUSES,
  isUnitInjectable,
  type CreatorKnowledgeUnit,
  type KnowledgeStatus,
} from '@/lib/creative/knowledgeUnit'
import type { LinkedWork } from '@/lib/creative/knowledgeLink'
import {
  AiStatus,
  EmptyState,
  ErrorState,
  PageHeader,
  PageShell,
  Section,
  SkeletonList,
  SurfaceCard,
  TagChip,
} from '@/components/vision'

// ────────────────────────────────────────────────────────────
// 我的知识库：跨素材归纳出的知识单元的确认入口
//
// 这里是「候选 → 已确认」的唯一发生地。AI 侧（/api/creative/knowledge/build）
// 永远只写候选；未经此处确认的单元不会进入内容生成。
// ────────────────────────────────────────────────────────────

type Filter = KnowledgeStatus | 'all'

/** 状态 → 标签色调（统一 TagChip，不再各自拼 rgba） */
const STATUS_TONE: Record<KnowledgeStatus, 'warm' | 'accent' | 'neutral' | 'muted'> = {
  候选: 'warm',
  已确认: 'accent',
  已拒绝: 'neutral',
  已过期: 'muted',
}

function confidenceColor(c: number): string {
  if (c >= 0.8) return '#34d399'
  if (c >= 0.6) return '#fbbf24'
  return '#fb7185'
}

/** 构建结果摘要 */
interface BuildSummary {
  groupCount: number
  inserted: number
  updated: number
  skipped: number
  degraded: boolean
}

/** /api/creative/projects 返回形状的最小投影：只声明本页真正读取的字段 */
interface ProjectApiRow {
  id?: string
  title?: string
  updatedAt?: string
  versions?: { id?: string }[]
}

/** 关联作品选择器用的候选：只带跳到最新版本所需的字段 */
interface WorkOption {
  id: string
  title: string
  updatedAt: string
  /** 最新版本 id：还没有版本时退化到 /works 列表 */
  latestVersionId: string | null
}

export default function KnowledgePage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [units, setUnits] = useState<CreatorKnowledgeUnit[]>([])
  const [filter, setFilter] = useState<Filter>('all')

  const [loadError, setLoadError] = useState('')
  /** 表未初始化时的可执行提示，区别于普通错误 */
  const [needMigration, setNeedMigration] = useState(false)

  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editClaim, setEditClaim] = useState('')

  const [building, setBuilding] = useState(false)
  const [buildSummary, setBuildSummary] = useState<BuildSummary | null>(null)
  const [buildError, setBuildError] = useState('')

  // ── 知识 ↔ 作品 关联（0011 起）──
  const [linksMap, setLinksMap] = useState<Record<string, LinkedWork[]>>({})
  /** 关联表没迁移时为 false：整块 UI 收起，而不是报错刷屏 */
  const [linksAvailable, setLinksAvailable] = useState(true)
  const [workOptions, setWorkOptions] = useState<WorkOption[]>([])
  const [pickerId, setPickerId] = useState<string | null>(null)
  const [linkBusy, setLinkBusy] = useState<string | null>(null)
  const [linkError, setLinkError] = useState('')
  const [backfilling, setBackfilling] = useState(false)
  const [backfillNote, setBackfillNote] = useState<string | null>(null)

  useEffect(() => {
    void fetchUnits(filter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  async function authHeaders(): Promise<Record<string, string> | null> {
    const session = await getValidSession()
    if (!session) {
      router.replace('/login')
      return null
    }
    return { Authorization: `Bearer ${session.access_token}` }
  }

  async function fetchUnits(nextFilter: Filter) {
    setLoadError('')
    setNeedMigration(false)
    setLoading(true)
    try {
      const headers = await authHeaders()
      if (!headers) return
      const query =
        nextFilter === 'all'
          ? '?withLinks=1'
          : `?status=${encodeURIComponent(nextFilter)}&withLinks=1`
      const res = await fetch(`/api/creative/knowledge${query}`, { headers })
      const data = await res.json()
      if (!res.ok) {
        // 迁移没跑 vs 网络故障，只能靠服务端显式标记区分：
        // 两者都可能落在 503 上（鉴权层网络失败同样返回 503），只看状态码
        // 会把一次断网谎报成"表没初始化"，让用户跑去重跑迁移。
        if (data.needsMigration === true) {
          setNeedMigration(true)
          setLoadError(data.error || '知识单元表尚未初始化')
        } else {
          setLoadError(data.error || (res.status === 503 ? '服务暂时不可用，请稍后重试' : '加载失败'))
        }
        setUnits([])
        return
      }
      setUnits(data.units ?? [])
      setLinksMap(data.links ?? {})
      // undefined 不该出现；服务端取不到会显式给 false
      if (typeof data.linksAvailable === 'boolean') {
        setLinksAvailable(data.linksAvailable)
      }
      // 候选作品一次性备好：点开选择器不再等请求，关联后也能直接跳转最新版本
      if (data.linksAvailable !== false) void ensureWorkOptions(headers)
    } catch {
      setLoadError('网络错误，加载失败')
      setUnits([])
    } finally {
      setLoading(false)
    }
  }

  /** 重新归纳：产出的新内容一律为候选，绝不改写已确认单元 */
  async function handleBuild() {
    if (building) return
    setBuilding(true)
    setBuildError('')
    setBuildSummary(null)
    try {
      const headers = await authHeaders()
      if (!headers) return
      const res = await fetch('/api/creative/knowledge/build', {
        method: 'POST',
        headers,
      })
      const data = await res.json()
      if (!res.ok) {
        if (data.needsMigration === true) {
          setNeedMigration(true)
          setBuildError(data.error || '知识单元表尚未初始化')
        } else {
          setBuildError(
            data.error || (res.status === 503 ? '服务暂时不可用，请稍后重试' : '构建失败')
          )
        }
        return
      }
      setBuildSummary({
        groupCount: data.group_count ?? 0,
        inserted: data.inserted ?? 0,
        updated: data.updated ?? 0,
        skipped: data.skipped_confirmed ?? 0,
        degraded: Boolean(data.degraded),
      })
      await fetchUnits(filter)
    } catch {
      setBuildError('网络错误，构建失败')
    } finally {
      setBuilding(false)
    }
  }

  async function patchUnit(
    id: string,
    payload: Partial<{ status: KnowledgeStatus; claim: string }>
  ) {
    if (busyId) return
    setBusyId(id)
    try {
      const headers = await authHeaders()
      if (!headers) return
      const res = await fetch(`/api/creative/knowledge/${id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        setLoadError(data.error || '操作失败')
        return
      }
      const updated: CreatorKnowledgeUnit | null = data.unit ?? null
      setUnits((prev) =>
        prev.map((u) => (u.id === id && updated ? updated : u))
      )
      if (filter !== 'all' && updated && updated.status !== filter) {
        // 已不满足当前筛选：从列表移除，避免"确认完还在候选页"的错觉
        setUnits((prev) => prev.filter((u) => u.id !== id))
      }
    } catch {
      setLoadError('网络错误，操作失败')
    } finally {
      setBusyId(null)
      setEditingId(null)
    }
  }

  function startEdit(u: CreatorKnowledgeUnit) {
    setEditingId(u.id)
    setEditClaim(u.claim)
  }

  // ─────────────── 知识 ↔ 作品 关联 ───────────────

  /**
   * 关联选择器候选。
   * 刻意复用 /works 的同一份接口 —— 不为一处 UI 新建一条读取口径，
   * 否则"这里能选的作品"和"那边展示的作品"迟早会各自漂移。
   */
  async function ensureWorkOptions(
    headers?: Record<string, string>
  ): Promise<WorkOption[]> {
    if (workOptions.length > 0) return workOptions
    const h = headers ?? (await authHeaders())
    if (!h) return []
    try {
      const res = await fetch('/api/creative/projects', { headers: h })
      const data = (await res.json().catch(() => null)) as {
        projects?: ProjectApiRow[]
      } | null
      if (!res.ok || !Array.isArray(data?.projects)) return []

      const options: WorkOption[] = []
      for (const p of data.projects ?? []) {
        if (typeof p?.id !== 'string' || !p.id) continue
        const versions = Array.isArray(p.versions) ? p.versions : []
        const latest = versions.length > 0 ? versions[versions.length - 1] : undefined
        options.push({
          id: p.id,
          title: typeof p.title === 'string' && p.title ? p.title : '未命名作品',
          updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
          latestVersionId:
            latest && typeof latest.id === 'string' ? latest.id : null,
        })
      }
      setWorkOptions(options)
      return options
    } catch {
      return []
    }
  }

  /** 手动关联：服务端会双侧校验归属，这里只负责搬运与回写 */
  async function linkWork(unitId: string, projectId: string) {
    if (linkBusy) return
    setLinkBusy(`${unitId}:${projectId}`)
    setLinkError('')
    try {
      const headers = await authHeaders()
      if (!headers) return
      const res = await fetch(`/api/creative/knowledge/${unitId}/links`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setLinkError(data.error ?? '关联失败')
        return
      }
      setLinksMap((prev) => ({
        ...prev,
        [unitId]: Array.isArray(data.links) ? data.links : [],
      }))
      setPickerId(null)
    } catch {
      setLinkError('网络错误，关联失败')
    } finally {
      setLinkBusy(null)
    }
  }

  async function unlinkWork(unitId: string, projectId: string) {
    if (linkBusy) return
    setLinkBusy(`${unitId}:${projectId}`)
    setLinkError('')
    try {
      const headers = await authHeaders()
      if (!headers) return
      const res = await fetch(
        `/api/creative/knowledge/${unitId}/links?projectId=${encodeURIComponent(projectId)}`,
        { method: 'DELETE', headers }
      )
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setLinkError(data?.error ?? '取消关联失败')
        return
      }
      setLinksMap((prev) => ({
        ...prev,
        [unitId]: (prev[unitId] ?? []).filter((w) => w.projectId !== projectId),
      }))
    } catch {
      setLinkError('网络错误，取消关联失败')
    } finally {
      setLinkBusy(null)
    }
  }

  /** 从 0006 的历史快照回填：让老作品一次性接上新结构 */
  async function handleBackfill() {
    if (backfilling) return
    setBackfilling(true)
    setBackfillNote(null)
    setLinkError('')
    try {
      const headers = await authHeaders()
      if (!headers) return
      const res = await fetch('/api/creative/knowledge/links-backfill', {
        method: 'POST',
        headers,
      })
      const data = await res.json()
      if (!res.ok) {
        setBackfillNote(data.error ?? '回填失败')
        return
      }
      const linked = Number(data.linked) || 0
      setBackfillNote(
        linked > 0
          ? `已从历史版本回填 ${linked} 条引用`
          : '历史版本里没有可回填的新引用'
      )
      await fetchUnits(filter)
    } catch {
      setBackfillNote('网络错误，回填失败')
    } finally {
      setBackfilling(false)
    }
  }

  /** 作品 id → 候选：让「被哪些作品用过」的 chip 能直接跳到那个作品的最新版本 */
  const workOptionById = new Map(workOptions.map((o) => [o.id, o]))

  return (
    <PageShell>
      <Link
        href="/dashboard"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-[var(--vs-ink-4)] transition hover:text-[var(--vs-ink)]"
      >
        ← 返回创作机会
      </Link>

      <PageHeader
        eyebrow="我的创作资产"
        title="知识库"
        description="AI 从你的多条素材里归纳出可复用的判断。它只负责提出候选，最后由你确认——被你确认过的知识，才会进入之后的每一次创作。"
        actions={
          <button
            onClick={handleBuild}
            disabled={building || needMigration}
            className="vs-btn vs-btn-primary disabled:opacity-50"
          >
            <RefreshCw size={14} className={building ? 'animate-spin' : ''} />
            {building ? '归纳中…' : '重新归纳'}
          </button>
        }
        ai={
          <AiStatus
            task="knowledge"
            active={loading || building}
            variant="bar"
          />
        }
      />

      {/* ── 表未初始化：给出可执行指令，而不是白屏 ── */}
      {needMigration && (
        <ErrorState
          className="mb-6"
          title="知识单元表尚未初始化"
          message="请在 Supabase 控制台执行 supabase/migrations/0005_creator_knowledge.sql，然后刷新本页。"
        />
      )}

      {/* ── 构建结果摘要 ── */}
      {buildSummary && (
        <SurfaceCard className="mb-6">
          <p className="text-[14px] font-medium text-[var(--vs-ink)]">
            本次归纳：新增 {buildSummary.inserted} 条候选，更新{' '}
            {buildSummary.updated} 条，跳过 {buildSummary.skipped} 条已确认
          </p>
          <p className="mt-1.5 vs-note leading-relaxed">
            {buildSummary.degraded
              ? 'AI 归纳调用失败，请稍后重试。已确认的单元不受影响。'
              : buildSummary.groupCount === 0
                ? '没有找到可归纳的分组 —— 一条知识单元至少需要来自 2 条不同素材的同类主张。'
                : '新增内容一律为「候选」，需你确认后才会生效。'}
          </p>
        </SurfaceCard>
      )}

      {buildError && !needMigration && (
        <ErrorState className="mb-6" message={buildError} onRetry={handleBuild} />
      )}

      {loadError && !needMigration && (
        <ErrorState
          className="mb-6"
          message={loadError}
          onRetry={() => fetchUnits(filter)}
        />
      )}

      {/* ── 知识单元 ── */}
      <Section
        title="知识卡片"
        description="每条知识都带着它的来源与适用领域。你确认得越准，AI 之后的创作就越像你。"
        actions={
          <div className="flex items-center gap-3">
            <span className="vs-note">{units.length} 条</span>
            {linksAvailable && (
              <button
                onClick={handleBackfill}
                disabled={backfilling || needMigration || units.length === 0}
                className="text-[12px] text-[var(--vs-ink-3)] transition hover:text-[var(--vs-ink)] disabled:opacity-40"
                title="把历史生成版本里用到的知识，回填成显式的知识↔作品关联"
              >
                {backfilling ? '回填中…' : '回填历史引用'}
              </button>
            )}
          </div>
        }
      >
        {/* 关联区的反馈：只影响这一块，不占用知识列表的主错误位 */}
        {(linkError || backfillNote) && linksAvailable && (
          <p
            className={`mb-4 rounded-xl border px-3.5 py-2.5 text-[13px] ${
              linkError
                ? 'vs-verdict vs-note-warn'
                : 'vs-verdict'
            }`}
          >
            {linkError ?? backfillNote}
          </p>
        )}

        {/* 状态筛选 */}
        <div className="mb-4 flex flex-wrap gap-1.5">
          {(['all', ...KNOWLEDGE_STATUSES] as Filter[]).map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                filter === s
                  ? 'border-[var(--vs-beam-line)] bg-[var(--vs-beam-wash)] text-[var(--vs-ink)]'
                  : 'border-white/[0.08] bg-[var(--vs-void-1)] text-[var(--vs-ink-3)] hover:border-white/20 hover:text-[var(--vs-ink)]'
              }`}
            >
              {s === 'all' ? '全部' : s}
            </button>
          ))}
        </div>

        {loading ? (
          <SkeletonList count={3} height={124} />
        ) : units.length === 0 ? (
          <EmptyState
            title={filter === 'all' ? '这里还没有知识单元' : `没有「${filter}」状态的单元`}
            description={
              filter === 'all'
                ? '先在「我的素材」里积累素材并完成 AI 理解。当同一主张出现在 2 条以上素材时，点「重新归纳」，AI 会把它提炼成知识候选。'
                : '切换上方的状态筛选，查看其他单元。'
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {units.map((u) => {
              const injectable = isUnitInjectable(u)
              const editing = editingId === u.id
              const linked = linksMap[u.id] ?? []
              const pickerOpen = pickerId === u.id
              return (
                <SurfaceCard key={u.id} className="vs-rise">
                  {/* 顶部：类型 / 状态 / 概念 */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TagChip tone="brand" size="sm">
                      {u.kind}
                    </TagChip>
                    <TagChip tone={STATUS_TONE[u.status]} size="sm">
                      {u.status}
                    </TagChip>
                    {injectable && (
                      <TagChip tone="accent" size="sm">
                        已用于创作
                      </TagChip>
                    )}
                  </div>

                  <h3 className="mt-2.5 text-[15px] font-semibold leading-snug text-[var(--vs-ink)]">
                    {u.concept}
                  </h3>

                  {editing ? (
                    <div className="mt-2">
                      <textarea
                        value={editClaim}
                        onChange={(e) => setEditClaim(e.target.value)}
                        rows={3}
                        maxLength={400}
                        className="vs-input vs-input-field w-full"
                      />
                      <div className="mt-2 flex items-center gap-3 text-xs">
                        <button
                          onClick={() => patchUnit(u.id, { claim: editClaim.trim() })}
                          disabled={busyId === u.id || !editClaim.trim()}
                          className="vs-link disabled:opacity-50"
                        >
                          保存修正
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="text-[var(--vs-ink-4)] transition hover:text-[var(--vs-ink-2)]"
                        >
                          取消
                        </button>
                        <span className="text-[var(--vs-ink-4)]">{editClaim.length}/400</span>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--vs-ink-2)]">
                      {u.claim}
                    </p>
                  )}

                  {/* 来源 / 领域 / 置信度 */}
                  {!editing && (
                    <>
                      <div className="vs-divider my-3" />
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="vs-note">来源</span>
                        <TagChip size="sm" tone="muted">
                          {u.sourceCount} 条素材
                        </TagChip>
                        {u.domainScope.map((d) => (
                          <TagChip key={d} size="sm">
                            {d}
                          </TagChip>
                        ))}
                        <span
                          className="ml-auto text-[12px]"
                          style={{ color: confidenceColor(u.confidence) }}
                        >
                          置信度 {Math.round(u.confidence * 100)}%
                        </span>
                        {u.confirmedAt && (
                          <span className="vs-note">
                            确认于 {new Date(u.confirmedAt).toLocaleDateString('zh-CN')}
                          </span>
                        )}
                      </div>
                    </>
                  )}

                  {/* ── 关联作品：这条知识具体体现在哪些作品里 ── */}
                  {!editing && linksAvailable && (
                    <div className="mt-3">
                      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                        <span className="text-[var(--vs-ink-4)]">被用在这些作品</span>
                        {linked.length === 0 ? (
                          <span className="text-[var(--vs-ink-4)]">还没有关联作品</span>
                        ) : (
                          linked.map((w) => {
                            const target = workOptionById.get(w.projectId)
                            const href = target?.latestVersionId
                              ? `/article/${target.latestVersionId}`
                              : '/works'
                            return (
                              <span
                                key={w.projectId}
                                className="vs-verdict"
                              >
                                <Link
                                  href={href}
                                  className="vs-link max-w-[180px] truncate"
                                  title={w.title}
                                >
                                  《{w.title}》
                                </Link>
                                <button
                                  type="button"
                                  onClick={() => void unlinkWork(u.id, w.projectId)}
                                  disabled={linkBusy === `${u.id}:${w.projectId}`}
                                  className="vs-link-danger text-[11px] disabled:opacity-40"
                                  title="取消关联"
                                >
                                  ×
                                </button>
                              </span>
                            )
                          })
                        )}
                        <button
                          type="button"
                          onClick={() => setPickerId(pickerOpen ? null : u.id)}
                          className="rounded-full border border-[var(--vs-line)] px-2.5 py-1 text-[var(--vs-ink-3)] transition hover:border-white/20 hover:text-[var(--vs-ink)]"
                        >
                          {pickerOpen ? '收起' : '关联作品'}
                        </button>
                      </div>

                      {pickerOpen && (
                        <div className="mt-2 rounded-xl border border-white/[0.08] bg-[var(--vs-void-1)] p-2">
                          {workOptions.length === 0 ? (
                            <p className="px-2 py-2 vs-note">
                              还没有可关联的作品 —— 先去创作一版内容。
                            </p>
                          ) : (
                            <ul className="max-h-56 overflow-y-auto">
                              {workOptions.map((opt) => {
                                const already = linked.some(
                                  (w) => w.projectId === opt.id
                                )
                                return (
                                  <li key={opt.id}>
                                    <button
                                      type="button"
                                      disabled={already || !!linkBusy}
                                      onClick={() => void linkWork(u.id, opt.id)}
                                      className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] transition ${
                                        already
                                          ? 'text-[var(--vs-ink-4)]'
                                          : 'text-[var(--vs-ink-2)] hover:bg-white/[0.06] hover:text-[var(--vs-ink)]'
                                      } disabled:opacity-60`}
                                    >
                                      <span className="truncate">{opt.title}</span>
                                      <span className="shrink-0 vs-note">
                                        {already
                                          ? '已关联'
                                          : opt.updatedAt
                                            ? new Date(opt.updatedAt).toLocaleDateString('zh-CN')
                                            : ''}
                                      </span>
                                    </button>
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 操作 */}
                  {!editing && (
                    <div className="mt-3.5 flex flex-wrap items-center gap-4 text-xs">
                      {u.status !== '已确认' ? (
                        <button
                          onClick={() => patchUnit(u.id, { status: '已确认' })}
                          disabled={busyId === u.id}
                          className="vs-link disabled:opacity-50"
                        >
                          确认
                        </button>
                      ) : (
                        <button
                          onClick={() => patchUnit(u.id, { status: '候选' })}
                          disabled={busyId === u.id}
                          className="text-[var(--vs-ink-4)] transition hover:text-[var(--vs-ink-2)] disabled:opacity-50"
                        >
                          撤回为候选
                        </button>
                      )}

                      {u.status !== '已拒绝' ? (
                        <button
                          onClick={() => patchUnit(u.id, { status: '已拒绝' })}
                          disabled={busyId === u.id}
                          className="vs-link-danger disabled:opacity-50"
                        >
                          拒绝
                        </button>
                      ) : (
                        <button
                          onClick={() => patchUnit(u.id, { status: '候选' })}
                          disabled={busyId === u.id}
                          className="text-[var(--vs-ink-4)] transition hover:text-[var(--vs-ink-2)] disabled:opacity-50"
                        >
                          恢复为候选
                        </button>
                      )}

                      <button
                        onClick={() => startEdit(u)}
                        disabled={busyId === u.id}
                        className="text-[var(--vs-ink-4)] transition hover:text-[var(--vs-ink)] disabled:opacity-50"
                      >
                        修正表述
                      </button>
                    </div>
                  )}
                </SurfaceCard>
              )
            })}
          </div>
        )}
      </Section>
    </PageShell>
  )
}
