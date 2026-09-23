'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getValidSession } from '@/lib/supabaseClient'
import {
  KNOWLEDGE_STATUSES,
  isUnitInjectable,
  type CreatorKnowledgeUnit,
  type KnowledgeStatus,
} from '@/lib/creative/knowledgeUnit'

// ────────────────────────────────────────────────────────────
// 我的知识库：跨素材归纳出的知识单元的确认入口
//
// 这里是「候选 → 已确认」的唯一发生地。AI 侧（/api/creative/knowledge/build）
// 永远只写候选；未经此处确认的单元不会进入内容生成。
// ────────────────────────────────────────────────────────────

type Filter = KnowledgeStatus | 'all'

const STATUS_STYLE: Record<KnowledgeStatus, { bg: string; color: string }> = {
  候选: { bg: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24' },
  已确认: { bg: 'rgba(16, 185, 129, 0.15)', color: '#34d399' },
  已拒绝: { bg: 'rgba(244, 63, 94, 0.15)', color: '#fb7185' },
  已过期: { bg: 'rgba(113, 113, 122, 0.2)', color: '#a1a1aa' },
}

const KIND_STYLE: Record<string, { bg: string; color: string }> = {
  事实: { bg: 'rgba(56, 189, 248, 0.15)', color: '#7dd3fc' },
  数据: { bg: 'rgba(167, 139, 250, 0.15)', color: '#c4b5fd' },
  观点: { bg: 'rgba(129, 140, 248, 0.15)', color: '#a5b4fc' },
  经历: { bg: 'rgba(52, 211, 153, 0.15)', color: '#6ee7b7' },
}

function Tag({
  text,
  bg,
  color,
}: {
  text: string
  bg: string
  color: string
}) {
  return (
    <span
      className="inner-item-tag"
      style={{ background: bg, color, borderColor: 'transparent' }}
    >
      {text}
    </span>
  )
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
      const url =
        nextFilter === 'all'
          ? '/api/creative/knowledge'
          : `/api/creative/knowledge?status=${encodeURIComponent(nextFilter)}`
      const res = await fetch(url, { headers })
      const data = await res.json()
      if (!res.ok) {
        if (res.status === 503) {
          setNeedMigration(true)
          setLoadError(data.error || '知识单元表尚未初始化')
        } else {
          setLoadError(data.error || '加载失败')
        }
        setUnits([])
        return
      }
      setUnits(data.units ?? [])
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
        if (res.status === 503) {
          setNeedMigration(true)
          setBuildError(data.error || '知识单元表尚未初始化')
        } else {
          setBuildError(data.error || '构建失败')
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

  return (
    <div className="inner-page">
      <div className="inner-container">
        {/* ── 头部 ── */}
        <header className="inner-header">
          <div>
            <Link href="/dashboard" className="inner-back">
              ← 返回我的素材库
            </Link>
            <h1 className="inner-header-title">我的知识库</h1>
            <p className="inner-header-sub">
              从多条素材中归纳出的跨素材知识单元。只有你手动「确认」过的单元，才会被注入内容生成。
            </p>
          </div>
          <button
            onClick={handleBuild}
            disabled={building || needMigration}
            className="inner-filter-chip active shrink-0 disabled:opacity-50"
            style={{ whiteSpace: 'nowrap' }}
          >
            {building ? '归纳中…' : '重新归纳'}
          </button>
        </header>

        {/* ── 表未初始化：给出可执行指令，而不是白屏 ── */}
        {needMigration && (
          <div
            className="inner-item"
            style={{ borderColor: 'rgba(251, 191, 36, 0.35)', marginBottom: 20 }}
          >
            <p className="inner-item-title">知识单元表尚未初始化</p>
            <p className="inner-item-desc">
              请在 Supabase 控制台执行{' '}
              <code
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  padding: '1px 6px',
                  borderRadius: 4,
                }}
              >
                supabase/migrations/0005_creator_knowledge.sql
              </code>
              ，然后刷新本页。
            </p>
          </div>
        )}

        {/* ── 构建结果摘要 ── */}
        {buildSummary && (
          <div className="inner-item" style={{ marginBottom: 20 }}>
            <p className="inner-item-title">
              本次归纳：新增 {buildSummary.inserted} 条候选，更新{' '}
              {buildSummary.updated} 条，跳过 {buildSummary.skipped} 条已确认
            </p>
            <p className="inner-item-desc">
              {buildSummary.degraded
                ? 'AI 归纳调用失败，请稍后重试。已确认的单元不受影响。'
                : buildSummary.groupCount === 0
                  ? '没有找到可归纳的分组 —— 一条知识单元至少需要来自 2 条不同素材的同类主张。'
                  : '新增内容一律为「候选」，需你确认后才会生效。'}
            </p>
          </div>
        )}

        {buildError && !needMigration && (
          <p style={{ color: '#fb7185', fontSize: 13, marginBottom: 20 }}>
            {buildError}
          </p>
        )}

        {/* ── 状态筛选 ── */}
        <div className="inner-filter-bar">
          <button
            onClick={() => setFilter('all')}
            className={`inner-filter-chip ${filter === 'all' ? 'active' : ''}`}
          >
            全部
          </button>
          {KNOWLEDGE_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`inner-filter-chip ${filter === s ? 'active' : ''}`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* ── 列表区 ── */}
        <div className="inner-section-head">
          <span className="inner-section-title">知识单元</span>
          <span className="inner-section-count">{units.length} 条</span>
        </div>

        {loadError && !needMigration && (
          <p style={{ color: '#fb7185', fontSize: 13, marginBottom: 16 }}>
            {loadError}
          </p>
        )}

        {loading ? (
          <div className="inner-empty">
            <p>加载中…</p>
          </div>
        ) : units.length === 0 ? (
          <div className="inner-empty">
            <p>{filter === 'all' ? '这里还没有知识单元' : `没有「${filter}」状态的单元`}</p>
            <p className="sub">
              {filter === 'all'
                ? '先在「我的素材库」积累素材并完成 AI 理解；当同一主张出现在 2 条以上素材时，点击右上角「重新归纳」生成候选'
                : '切换上方的状态筛选查看其他单元'}
            </p>
          </div>
        ) : (
          <div className="inner-list">
            {units.map((u) => {
              const st = STATUS_STYLE[u.status]
              const kd = KIND_STYLE[u.kind] ?? KIND_STYLE['观点']
              const injectable = isUnitInjectable(u)
              const editing = editingId === u.id
              return (
                <div key={u.id} className="inner-item anim-rise">
                  {/* 顶部行：种类 / 状态 / 概念 */}
                  <div
                    className="flex items-center justify-between gap-3 flex-wrap"
                    style={{ marginBottom: 10 }}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <Tag text={u.kind} bg={kd.bg} color={kd.color} />
                      <Tag text={u.status} bg={st.bg} color={st.color} />
                      <span className="inner-item-title" style={{ margin: 0 }}>
                        {u.concept}
                      </span>
                      {injectable && (
                        <span
                          className="inner-item-tag"
                          style={{
                            background: 'rgba(16, 185, 129, 0.12)',
                            color: '#34d399',
                            borderColor: 'transparent',
                          }}
                        >
                          注入生成中
                        </span>
                      )}
                    </div>
                    <span className="inner-item-date shrink-0">
                      来源 {u.sourceCount} 条素材
                    </span>
                  </div>

                  {/* 命题正文 / 编辑 */}
                  {editing ? (
                    <div>
                      <textarea
                        value={editClaim}
                        onChange={(e) => setEditClaim(e.target.value)}
                        rows={3}
                        maxLength={400}
                        className="w-full rounded-lg text-sm outline-none"
                        style={{
                          background: 'rgba(255,255,255,0.05)',
                          border: '1px solid rgba(255,255,255,0.12)',
                          color: '#fff',
                          padding: '10px 12px',
                          resize: 'vertical',
                        }}
                      />
                      <div className="flex items-center gap-3 mt-2 text-xs">
                        <button
                          onClick={() =>
                            patchUnit(u.id, { claim: editClaim.trim() })
                          }
                          disabled={busyId === u.id || !editClaim.trim()}
                          className="text-indigo-300 hover:text-indigo-200 disabled:opacity-50 transition"
                        >
                          保存修正
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="text-zinc-500 hover:text-zinc-300 transition"
                        >
                          取消
                        </button>
                        <span className="text-zinc-600">
                          {editClaim.length}/400
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="inner-item-desc">{u.claim}</p>
                  )}

                  {/* 底部：适用场景 + 置信度 */}
                  {!editing && (
                    <div className="flex items-center gap-2 flex-wrap mt-2">
                      {u.domainScope.map((d) => (
                        <span key={d} className="inner-item-tag">
                          {d}
                        </span>
                      ))}
                      <span
                        className="inner-item-tag"
                        style={{
                          background: 'transparent',
                          color: confidenceColor(u.confidence),
                          borderColor: 'transparent',
                        }}
                      >
                        置信度 {Math.round(u.confidence * 100)}%
                      </span>
                      {u.confirmedAt && (
                        <span className="inner-item-date">
                          确认于 {new Date(u.confirmedAt).toLocaleDateString('zh-CN')}
                        </span>
                      )}
                    </div>
                  )}

                  {/* 操作区 */}
                  {!editing && (
                    <div className="flex items-center gap-4 mt-3 text-xs">
                      {u.status !== '已确认' ? (
                        <button
                          onClick={() => patchUnit(u.id, { status: '已确认' })}
                          disabled={busyId === u.id}
                          className="text-emerald-400 hover:text-emerald-300 disabled:opacity-50 transition"
                        >
                          确认
                        </button>
                      ) : (
                        <button
                          onClick={() => patchUnit(u.id, { status: '候选' })}
                          disabled={busyId === u.id}
                          className="text-zinc-500 hover:text-zinc-300 disabled:opacity-50 transition"
                        >
                          撤回为候选
                        </button>
                      )}

                      {u.status !== '已拒绝' ? (
                        <button
                          onClick={() => patchUnit(u.id, { status: '已拒绝' })}
                          disabled={busyId === u.id}
                          className="text-zinc-500 hover:text-red-400 disabled:opacity-50 transition"
                        >
                          拒绝
                        </button>
                      ) : (
                        <button
                          onClick={() => patchUnit(u.id, { status: '候选' })}
                          disabled={busyId === u.id}
                          className="text-zinc-500 hover:text-zinc-300 disabled:opacity-50 transition"
                        >
                          恢复为候选
                        </button>
                      )}

                      <button
                        onClick={() => startEdit(u)}
                        disabled={busyId === u.id}
                        className="text-zinc-500 hover:text-indigo-300 disabled:opacity-50 transition"
                      >
                        修正表述
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
