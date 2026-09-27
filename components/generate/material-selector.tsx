'use client'

// ============================================================
// MaterialSelector —— Material Library 2.0 Phase 4 素材选择组件
//
// 三种模式 Tab 切换：
//   1. 推荐模式（默认）：POST /api/materials/retrieve，reasonMode:'llm'，带 usage_tag 做 currentIntent
//      → AI 推荐列表 + relevanceReason + 默认全勾选
//   2. 手动挑选：GET /api/materials（支持 ?groupId=&type=&q=），左侧分组侧栏 + 顶部 type 下拉 + 搜索
//      → 用户全量素材列表 + 勾选框
//   3. 不使用：大提示 + 确认，不传 selectedMaterialIds
//
// 鉴权：前端调 fetch 需 accessToken（Bearer），父组件传入
// 样式：复用 inner-page/vs-rise class，保持 data-mode="creator" 风格一致
// ============================================================

import { useEffect, useRef, useState } from 'react'
import {
  MATERIAL_ANNOTATION_TAGS,
  MATERIAL_TYPES,
  MATERIAL_TYPE_RULES,
  type MaterialAnnotation,
  type MaterialAnnotationTag,
  type MaterialType,
} from '@/lib/creative/material'

/** 单条素材的本地注解形态（未选中素材不持有注解） */
interface LocalAnnotation {
  role: 'foundation' | 'reference'
  tags: MaterialAnnotationTag[]
  note: string
}

const EMPTY_ANNOTATION: LocalAnnotation = { role: 'reference', tags: [], note: '' }

/** retrieve API 返回的单条推荐素材（与 MaterialRetrievalResult 同构） */
interface RecommendedMaterial {
  materialId: string
  content: string
  materialType: MaterialType | null
  relevanceScore: number
  relevanceReason: string
}

/** GET /api/materials 返回的简化素材行 */
interface MaterialRow {
  id: string
  content: string
  material_type: MaterialType | null
  group_id: string | null
  group_name?: string
  created_at?: string
}

/** GET /api/material-groups 返回的分组行 */
interface GroupRow {
  id: string
  name: string
}

export type MaterialSelectorMode = 'recommended' | 'manual' | 'none'

interface MaterialSelectorProps {
  topic: string
  /** 从 blueprint 拿 usage_tag，传给 retrieve 做 currentIntent */
  blueprintUsageTag?: string | null
  /** 从 blueprint 拿 content_type（可能为 null） */
  blueprintContentType?: string | null
  /** fetch 鉴权用的 access token */
  accessToken: string
  /** 选好后调这个回调；annotations 含全部选中素材（role/tags/note），空数组=不使用 */
  onConfirm: (annotations: MaterialAnnotation[], mode: MaterialSelectorMode) => void
  /** 返回按钮 */
  onBack: () => void
}

export function MaterialSelector({
  topic,
  blueprintUsageTag,
  blueprintContentType,
  accessToken,
  onConfirm,
  onBack,
}: MaterialSelectorProps) {
  const [mode, setMode] = useState<MaterialSelectorMode>('recommended')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // 选中素材的注解（根基角色/预设标签/自由备注），key=materialId
  const [annotationsMap, setAnnotationsMap] = useState<Record<string, LocalAnnotation>>({})

  // ── 推荐模式状态 ──
  const [recommended, setRecommended] = useState<RecommendedMaterial[]>([])
  const [recommendLoading, setRecommendLoading] = useState(false)
  const [recommendError, setRecommendError] = useState<string | null>(null)

  // ── 手动挑选状态 ──
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [manualGroupId, setManualGroupId] = useState<string>('all') // 'all' | 'uncategorized' | uuid
  const [manualType, setManualType] = useState<MaterialType | ''>('')
  const [manualQuery, setManualQuery] = useState('')
  const [manualMaterials, setManualMaterials] = useState<MaterialRow[]>([])
  const [manualLoading, setManualLoading] = useState(false)
  const [manualError, setManualError] = useState<string | null>(null)
  const manualAbortRef = useRef<AbortController | null>(null)

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  }

  // ── 推荐模式：切进来时自动 fetch ──
  useEffect(() => {
    if (mode !== 'recommended') return
    let cancelled = false
    ;(async () => {
      setRecommendLoading(true)
      setRecommendError(null)
      try {
        const res = await fetch('/api/materials/retrieve', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            currentTopic: topic,
            currentIntent: blueprintUsageTag ?? blueprintContentType ?? undefined,
            reasonMode: 'llm',
          }),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.error || '推荐列表获取失败')
        const list: RecommendedMaterial[] = Array.isArray(data?.materials)
          ? data.materials
          : []
        if (!cancelled) {
          setRecommended(list)
          // 默认全选
          setSelectedIds(new Set(list.map((m) => m.materialId)))
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : '网络错误'
          setRecommendError(msg)
        }
      } finally {
        if (!cancelled) setRecommendLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, topic, blueprintUsageTag, blueprintContentType])

  // ── 手动挑选：切进来时 fetch 分组 + 素材列表（带过滤器） ──
  useEffect(() => {
    if (mode !== 'manual') return
    let cancelled = false

    // 并行拉分组 + 素材列表
    ;(async () => {
      try {
        // 分组列表
        const gRes = await fetch('/api/material-groups', { headers })
        const gData = await gRes.json().catch(() => null)
        if (!cancelled && gRes.ok) {
          setGroups(Array.isArray(gData?.groups) ? gData.groups : [])
        }

        // 素材列表（带过滤器）
        setManualLoading(true)
        setManualError(null)
        if (manualAbortRef.current) manualAbortRef.current.abort()
        const controller = new AbortController()
        manualAbortRef.current = controller

        const params = new URLSearchParams()
        if (manualGroupId) params.set('groupId', manualGroupId)
        if (manualType) params.set('type', manualType)
        if (manualQuery.trim()) params.set('q', manualQuery.trim())

        const mRes = await fetch(`/api/materials?${params.toString()}`, {
          headers,
          signal: controller.signal,
        })
        const mData = await mRes.json().catch(() => null)
        if (!cancelled && !controller.signal.aborted) {
          if (!mRes.ok) throw new Error(mData?.error || '素材列表获取失败')
          const list: MaterialRow[] = Array.isArray(mData?.materials)
            ? mData.materials
            : []
          setManualMaterials(list)
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : '网络错误'
          setManualError(msg)
        }
      } finally {
        if (!cancelled) setManualLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, manualGroupId, manualType, manualQuery])

  function toggleSelect(id: string) {
    let willSelect = false
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        willSelect = true
      }
      return next
    })
    // 取消勾选时连同注解一起清除（含根基身份）
    setAnnotationsMap((prev) => {
      if (willSelect || !prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  /** 设为/取消创作根基（全局单选：设新根基自动取消旧根基） */
  function toggleFoundation(id: string) {
    setAnnotationsMap((prev) => {
      const cur = prev[id] ?? EMPTY_ANNOTATION
      const isAlreadyFoundation = cur.role === 'foundation'
      const next: Record<string, LocalAnnotation> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (k === id) continue
        // 取消旧根基 → 降为普通参考
        next[k] = v.role === 'foundation' ? { ...v, role: 'reference' } : v
      }
      if (!isAlreadyFoundation) {
        next[id] = { ...cur, role: 'foundation' }
      }
      return next
    })
  }

  function toggleTag(id: string, tag: MaterialAnnotationTag) {
    setAnnotationsMap((prev) => {
      const cur = prev[id] ?? EMPTY_ANNOTATION
      const has = cur.tags.includes(tag)
      const tags = has ? cur.tags.filter((t) => t !== tag) : [...cur.tags, tag].slice(0, 4)
      return { ...prev, [id]: { ...cur, tags } }
    })
  }

  function setNote(id: string, note: string) {
    setAnnotationsMap((prev) => {
      const cur = prev[id] ?? EMPTY_ANNOTATION
      return { ...prev, [id]: { ...cur, note: note.slice(0, 200) } }
    })
  }

  /** 当前根基 id（没有则 null） */
  function getFoundationId(): string | null {
    for (const [id, a] of Object.entries(annotationsMap)) {
      if (a.role === 'foundation') return id
    }
    return null
  }

  function toggleSelectAll() {
    if (mode === 'recommended') {
      if (selectedIds.size === recommended.length) {
        setSelectedIds(new Set())
        setAnnotationsMap({})
      } else {
        setSelectedIds(new Set(recommended.map((m) => m.materialId)))
      }
    } else {
      if (selectedIds.size === manualMaterials.length) {
        setSelectedIds(new Set())
        setAnnotationsMap({})
      } else {
        setSelectedIds(new Set(manualMaterials.map((m) => m.id)))
      }
    }
  }

  function isCardSelected(id: string) {
    return selectedIds.has(id)
  }

  function handleConfirm() {
    if (mode === 'none') {
      onConfirm([], 'none')
      return
    }
    // 限制 ≤10 个（Phase 3 MAX_SELECTED 硬限制）；注解随选中集输出
    const ids = Array.from(selectedIds).slice(0, 10)
    const annotations: MaterialAnnotation[] = ids.map((id) => {
      const a = annotationsMap[id] ?? EMPTY_ANNOTATION
      return { materialId: id, role: a.role, tags: a.tags, note: a.note.trim() }
    })
    onConfirm(annotations, mode)
  }

  const canConfirm =
    mode === 'recommended' || mode === 'manual'
      ? selectedIds.size >= 0 // 0 也允许（用户全取消 = 不传）
      : true
  const hasError = mode === 'recommended' ? !!recommendError : !!manualError

  // 根基素材摘要（用于确认按钮文案）
  const foundationId = getFoundationId()
  const foundationPreview = (() => {
    if (!foundationId) return ''
    const list: Array<{ id: string; content: string }> =
      mode === 'recommended'
        ? recommended.map((m) => ({ id: m.materialId, content: m.content }))
        : manualMaterials.map((m) => ({ id: m.id, content: m.content }))
    const item = list.find((x) => x.id === foundationId)
    const text = item?.content.trim() ?? ''
    return text.length > 12 ? `${text.slice(0, 12)}…` : text
  })()

  const confirmLabel =
    mode === 'none'
      ? '确认不使用，开始生成'
      : selectedIds.size === 0
        ? '跳过素材选择，开始生成'
        : foundationId
          ? `以《${foundationPreview}》为根基${
              selectedIds.size > 1 ? ` + ${selectedIds.size - 1} 条参考` : ''
            }，开始生成`
          : `使用选中的 ${selectedIds.size} 条素材，开始生成`

  return (
    <div className="anim-rise">
      {/* 顶部栏：标题 + 返回 */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h2 className="vs-h3">选择素材</h2>
          <p className="vs-note mt-1.5 leading-relaxed">
            AI 会在生成你的文案时参考这些素材，让内容更贴合你。选中后可把 1 条素材设为「创作根基」并补充使用标签（仅本次生效）
          </p>
        </div>
        <button type="button" onClick={onBack} className="vs-btn vs-btn-ghost vs-btn-sm shrink-0">
          ← 返回方案
        </button>
      </div>

      {/* Tab 切换 */}
      <div className="flex flex-wrap gap-2 mb-5">
        {(
          [
            ['recommended', 'AI 推荐'],
            ['manual', '手动挑选'],
            ['none', '不使用素材'],
          ] as const
        ).map(([m, label]) => {
          const active = mode === m
          return (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m)
                // 切 tab 重置选择与注解（与既有"tab 间不保留勾选"行为一致）
                setAnnotationsMap({})
                if (m === 'recommended') {
                  setSelectedIds(new Set(recommended.map((r) => r.materialId)))
                } else {
                  setSelectedIds(new Set())
                }
              }}
              data-on={active}
              className="vs-chip"
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* ── 推荐模式 ── */}
      {mode === 'recommended' && (
        <div>
          {recommendLoading && (
            <div className="flex flex-col items-center py-16">
              <span className="vs-ai-dots" aria-hidden="true">
                <i className="vs-ai-dot" />
                <i className="vs-ai-dot" />
                <i className="vs-ai-dot" />
              </span>
              <p className="vs-note mt-4">正在为你推荐相关素材</p>
            </div>
          )}
          {!recommendLoading && recommendError && (
            <div className="flex flex-col items-center py-10">
              <p className="vs-error mb-3">推荐获取失败：{recommendError}</p>
              <button
                type="button"
                onClick={() => {
                  setRecommendError(null)
                  // 触发 useEffect 重新 fetch：用空 topic 无效，改手动切一次
                  setMode('manual')
                  setTimeout(() => setMode('recommended'), 0)
                }}
                className="vs-link"
              >
                切到手动挑选
              </button>
            </div>
          )}
          {!recommendLoading && !recommendError && recommended.length === 0 && (
            <div className="text-center py-10">
              <p className="vs-note">AI 没找到与你主题相关的素材</p>
              <p className="vs-note mt-2">
                可以切到「手动挑选」从你的素材库中选择，或者「不使用素材」让 AI 自由发挥
              </p>
            </div>
          )}
          {!recommendLoading && !recommendError && recommended.length > 0 && (
            <>
              <div className="flex items-center justify-between mb-3">
                <p className="vs-note">
                  共 <span className="vs-num">{recommended.length}</span> 条推荐，已选{' '}
                  <span className="vs-num">{selectedIds.size}</span> 条
                </p>
                <button type="button" onClick={toggleSelectAll} className="vs-link">
                  {selectedIds.size === recommended.length ? '全取消' : '全选'}
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {recommended.map((m) => (
                  <RecommendedCard
                    key={m.materialId}
                    material={m}
                    selected={isCardSelected(m.materialId)}
                    onToggle={() => toggleSelect(m.materialId)}
                    annotation={annotationsMap[m.materialId]}
                    onToggleFoundation={() => toggleFoundation(m.materialId)}
                    onToggleTag={(tag) => toggleTag(m.materialId, tag)}
                    onNoteChange={(note) => setNote(m.materialId, note)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── 手动挑选模式 ── */}
      {mode === 'manual' && (
        <div>
          {/* 过滤器行 */}
          <div className="flex flex-wrap items-end gap-4 mb-5">
            {/* 分组侧栏（小型下拉选择） */}
            <select
              value={manualGroupId}
              onChange={(e) => setManualGroupId(e.target.value)}
              className="vs-select"
            >
              <option value="all">全部素材</option>
              <option value="uncategorized">未分组</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>

            {/* type 下拉 */}
            <select
              value={manualType}
              onChange={(e) =>
                setManualType(
                  e.target.value === '' ? '' : (e.target.value as MaterialType)
                )
              }
              className="vs-select"
            >
              <option value="">全部类型</option>
              {MATERIAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>

            {/* 搜索 */}
            <input
              type="text"
              value={manualQuery}
              onChange={(e) => setManualQuery(e.target.value)}
              placeholder="搜索关键词…"
              className="vs-input vs-input-field flex-1 min-w-[140px]"
            />
          </div>

          {manualLoading && (
            <div className="flex flex-col items-center py-12">
              <span className="vs-ai-dots" aria-hidden="true">
                <i className="vs-ai-dot" />
                <i className="vs-ai-dot" />
                <i className="vs-ai-dot" />
              </span>
              <p className="vs-note mt-4">正在加载素材</p>
            </div>
          )}
          {!manualLoading && manualError && (
            <p className="vs-error py-6 text-center">素材列表加载失败：{manualError}</p>
          )}
          {!manualLoading && !manualError && manualMaterials.length === 0 && (
            <p className="vs-note py-10 text-center">当前筛选条件下没有素材</p>
          )}
          {!manualLoading && !manualError && manualMaterials.length > 0 && (
            <>
              <div className="flex items-center justify-between mb-3">
                <p className="vs-note">
                  共 <span className="vs-num">{manualMaterials.length}</span> 条素材，已选{' '}
                  <span className="vs-num">{selectedIds.size}</span> 条
                </p>
                <button type="button" onClick={toggleSelectAll} className="vs-link">
                  {selectedIds.size === manualMaterials.length ? '全取消' : '全选'}
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {manualMaterials.map((m) => (
                  <ManualCard
                    key={m.id}
                    material={m}
                    selected={isCardSelected(m.id)}
                    onToggle={() => toggleSelect(m.id)}
                    annotation={annotationsMap[m.id]}
                    onToggleFoundation={() => toggleFoundation(m.id)}
                    onToggleTag={(tag) => toggleTag(m.id, tag)}
                    onNoteChange={(note) => setNote(m.id, note)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── 不使用模式 ── */}
      {mode === 'none' && (
        <div className="py-14 text-center">
          <h3 className="vs-h3">本次创作不手动挑选素材</h3>
          <p className="vs-note mt-3 mx-auto max-w-xs leading-relaxed">
            系统仍会自动召回与你主题相关的素材作为兜底，保证内容质量不会下降。
            你也可以随时回到素材库中整理和补充。
          </p>
        </div>
      )}

      {/* 底部按钮 */}
      <div className="mt-6 pt-4 border-t border-[var(--vs-line)] flex flex-wrap justify-end gap-3">
        <button type="button" onClick={onBack} className="vs-btn vs-btn-ghost">
          返回调整方案
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!canConfirm || (mode !== 'none' && hasError)}
          className="vs-btn vs-btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}

// ── 卡片注解操作的公共 props ──

interface AnnotationActionProps {
  annotation?: LocalAnnotation
  onToggleFoundation: () => void
  onToggleTag: (tag: MaterialAnnotationTag) => void
  onNoteChange: (note: string) => void
}

/**
 * 卡片外框：根基 > 选中 > 默认，是同一个强调色的三级明度，不是三套颜色。
 * 不用外发光——一排卡片各有各的光晕时会互相打架，看不出哪个才是重点。
 */
function cardFrameClass(selected: boolean, isFoundation: boolean): string {
  if (isFoundation) {
    return 'border-[var(--vs-beam)] bg-[var(--vs-beam-wash)]'
  }
  if (selected) {
    return 'border-[var(--vs-beam-line)] bg-[var(--vs-beam-wash)]'
  }
  return 'border-[var(--vs-line)] bg-transparent hover:border-[var(--vs-line-2)]'
}

/** 勾选框（点击整张卡片头部区域切换选中） */
function CheckboxMark({ selected }: { selected: boolean }) {
  return (
    <div
      className={`absolute top-3 right-3 w-5 h-5 rounded-[var(--vs-r-sm)] border flex items-center justify-center text-[11px] transition ${
        selected
          ? 'border-[var(--vs-beam)] bg-[var(--vs-beam)] text-[#0a0c10]'
          : 'border-[var(--vs-line-2)] text-transparent'
      }`}
    >
      ✓
    </div>
  )
}

/** 选中后展开的注解面板：设为根基 + 预设标签 + 自由备注（仅本次生成生效） */
function AnnotationPanel({
  annotation,
  onToggleFoundation,
  onToggleTag,
  onNoteChange,
}: AnnotationActionProps) {
  const a = annotation ?? EMPTY_ANNOTATION
  const isFoundation = a.role === 'foundation'

  return (
    <div className="mt-3 pt-3 border-t border-[var(--vs-line)] space-y-3">
      <button
        type="button"
        onClick={onToggleFoundation}
        data-on={isFoundation}
        className="vs-chip"
      >
        {isFoundation ? '已设为创作根基（点击取消）' : '设为创作根基'}
      </button>

      <div className="flex flex-wrap gap-1.5">
        {MATERIAL_ANNOTATION_TAGS.map((tag) => {
          const active = a.tags.includes(tag)
          return (
            <button
              key={tag}
              type="button"
              onClick={() => onToggleTag(tag)}
              data-on={active}
              className="vs-chip"
            >
              {tag}
            </button>
          )
        })}
      </div>

      <textarea
        value={a.note}
        onChange={(e) => onNoteChange(e.target.value)}
        rows={2}
        maxLength={200}
        placeholder="给 AI 的使用说明（仅本次生效），如：这是我本人的产品，定位是灵感直通车"
        className="vs-input vs-input-field resize-none leading-relaxed"
      />
    </div>
  )
}

// ── 子组件：推荐卡片 ──

function RecommendedCard({
  material,
  selected,
  onToggle,
  annotation,
  onToggleFoundation,
  onToggleTag,
  onNoteChange,
}: {
  material: RecommendedMaterial
  selected: boolean
  onToggle: () => void
} & AnnotationActionProps) {
  const rule = material.materialType
    ? MATERIAL_TYPE_RULES[material.materialType]
    : null
  const typeLabel = material.materialType ?? '其他'
  const isFoundation = annotation?.role === 'foundation'

  return (
    <div
      className={`text-left relative rounded-[var(--vs-r)] border p-3.5 transition ${cardFrameClass(
        selected,
        isFoundation
      )}`}
    >
      {/* 点击头部区域 = 勾选/取消（注解面板内的控件在其外部，不会误触发） */}
      <div role="checkbox" aria-checked={selected} tabIndex={0} onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        className="cursor-pointer outline-none">
        <CheckboxMark selected={selected} />

        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="vs-verdict">{typeLabel}</span>
          {isFoundation && <span className="vs-verdict">创作根基</span>}
          {rule && <span className="vs-note">{rule.usageRule}</span>}
        </div>

        <p className="text-[13px] leading-relaxed text-[var(--vs-ink-3)] line-clamp-3 pr-6">
          {material.content.trim().slice(0, 200)}
          {material.content.trim().length > 200 ? '…' : ''}
        </p>

        <div className="mt-2.5 pt-2.5 border-t border-[var(--vs-line)]">
          <p className="text-[13px] leading-relaxed text-[var(--vs-beam-text)]">
            {material.relevanceReason}
          </p>
        </div>
      </div>

      {selected && (
        <AnnotationPanel
          annotation={annotation}
          onToggleFoundation={onToggleFoundation}
          onToggleTag={onToggleTag}
          onNoteChange={onNoteChange}
        />
      )}
    </div>
  )
}

// ── 子组件：手动挑选卡片 ──

function ManualCard({
  material,
  selected,
  onToggle,
  annotation,
  onToggleFoundation,
  onToggleTag,
  onNoteChange,
}: {
  material: MaterialRow
  selected: boolean
  onToggle: () => void
} & AnnotationActionProps) {
  const typeLabel = material.material_type ?? '其他'
  const rule = material.material_type
    ? MATERIAL_TYPE_RULES[material.material_type]
    : null
  const isFoundation = annotation?.role === 'foundation'

  return (
    <div
      className={`text-left relative rounded-[var(--vs-r)] border p-3.5 transition ${cardFrameClass(
        selected,
        isFoundation
      )}`}
    >
      <div role="checkbox" aria-checked={selected} tabIndex={0} onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        className="cursor-pointer outline-none">
        <CheckboxMark selected={selected} />

        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="vs-verdict">{typeLabel}</span>
          {isFoundation && <span className="vs-verdict">创作根基</span>}
          {rule && <span className="vs-note">{rule.usageRule}</span>}
        </div>

        <p className="text-[13px] leading-relaxed text-[var(--vs-ink-3)] line-clamp-3 pr-6">
          {material.content.trim().slice(0, 200)}
          {material.content.trim().length > 200 ? '…' : ''}
        </p>
      </div>

      {selected && (
        <AnnotationPanel
          annotation={annotation}
          onToggleFoundation={onToggleFoundation}
          onToggleTag={onToggleTag}
          onNoteChange={onNoteChange}
        />
      )}
    </div>
  )
}
