'use client'

// ============================================================
// PerformanceCard（发布表现回流卡）—— 闭环最后一环
//
// 站内 👍/👎 衡量"AI 生成质量"，这张卡记录"发布到平台后的真实表现"。
// 三档自评（不错/一般/扑了）+ 可选平台 + 可选备注，覆盖式更新。
//
// 数据沉淀用途（见 setup.sql 第 15 节）：
//   generation_history.performance_feedback ←→ blueprint.content_strategy 关联分析
//   → "哪种战略模式的作品表现更好" → 反哺战略块与灵感推荐。
// ============================================================

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

type Grade = 'good' | 'okay' | 'flop'
type Platform = 'wechat' | 'xhs' | 'douyin' | 'bilibili' | 'zhihu' | 'other'

interface PerformanceData {
  grade: Grade
  platform: Platform | null
  note: string | null
  recorded_at: string
}

const GRADE_META: Record<Grade, { label: string; emoji: string; activeClass: string }> = {
  good: { label: '表现不错', emoji: '😀', activeClass: 'bg-emerald-600 border-emerald-500 text-white' },
  okay: { label: '表现一般', emoji: '😐', activeClass: 'bg-amber-600 border-amber-500 text-white' },
  flop: { label: '扑了', emoji: '😔', activeClass: 'bg-zinc-600 border-zinc-400 text-white' },
}

const PLATFORM_OPTIONS: Array<{ value: Platform; label: string }> = [
  { value: 'wechat', label: '公众号' },
  { value: 'xhs', label: '小红书' },
  { value: 'douyin', label: '抖音' },
  { value: 'bilibili', label: 'B站' },
  { value: 'zhihu', label: '知乎' },
  { value: 'other', label: '其他平台' },
]

const GRADE_BADGE_CLASS: Record<Grade, string> = {
  good: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  okay: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  flop: 'text-zinc-300 bg-zinc-500/10 border-zinc-500/30',
}

interface PerformanceCardProps {
  /** generation_history 行 id（版本行，性能数据随行落库） */
  generationId?: string
}

export function PerformanceCard({ generationId }: PerformanceCardProps) {
  const [performance, setPerformance] = useState<PerformanceData | null>(null)
  const [editing, setEditing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loggedIn, setLoggedIn] = useState(false)

  const [grade, setGrade] = useState<Grade | null>(null)
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 恢复已记录表现（setState 均在 .then 回调内，避免 effect 同步 setState）
  useEffect(() => {
    let cancelled = false
    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        if (cancelled) return null
        if (!generationId || !session?.access_token) return null
        setLoggedIn(true)
        return fetch(`/api/works/performance?id=${encodeURIComponent(generationId)}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
      })
      .then(async (res) => {
        if (cancelled || !res) return
        const data = await res.json().catch(() => null)
        if (!cancelled && data?.performance) {
          setPerformance(data.performance as PerformanceData)
        }
      })
      .catch(() => {
        // 恢复失败静默：视为未记录
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [generationId])

  const startEdit = () => {
    // 回填当前值（更新场景）
    setGrade(performance?.grade ?? null)
    setPlatform(performance?.platform ?? '')
    setNote(performance?.note ?? '')
    setError(null)
    setEditing(true)
  }

  const submit = async () => {
    if (!generationId || !grade) return
    setSaving(true)
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setError('登录态已失效，请刷新页面重新登录')
        setSaving(false)
        return
      }
      const res = await fetch('/api/works/performance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          generationId,
          grade,
          platform: platform || null,
          note: note.trim() || null,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setError(data?.error ?? '记录失败，请稍后重试')
        return
      }
      setPerformance(data.performance as PerformanceData)
      setEditing(false)
    } catch {
      setError('网络异常，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return null

  // 未登录或无落库行：不打扰
  if (!loggedIn || !generationId) return null

  // ── 已记录态：紧凑展示 + 可更新 ──
  if (performance && !editing) {
    const meta = GRADE_META[performance.grade]
    const platformLabel = performance.platform
      ? PLATFORM_OPTIONS.find((p) => p.value === performance.platform)?.label
      : null
    return (
      <div className="mt-8 rounded-xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 to-teal-500/5 px-6 py-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              <span>📊</span> 发布表现
            </h2>
            <div className="mt-2.5 flex items-center gap-2 flex-wrap">
              <span className={`px-2.5 py-1 rounded-full text-xs border ${GRADE_BADGE_CLASS[performance.grade]}`}>
                {meta.emoji} {meta.label}
              </span>
              {platformLabel && (
                <span className="px-2.5 py-1 rounded-full text-xs text-zinc-300 bg-zinc-500/10 border border-zinc-500/30">
                  {platformLabel}
                </span>
              )}
              <span className="text-[11px] text-zinc-500">
                记录于 {new Date(performance.recorded_at).toLocaleDateString('zh-CN')}
              </span>
            </div>
            {performance.note && (
              <p className="mt-2 text-xs text-zinc-400 leading-relaxed">{performance.note}</p>
            )}
            <p className="mt-2 text-[11px] text-zinc-500">
              表现数据会与你的创作战略关联分析，帮助系统学会哪种选题方式更适合你。
            </p>
          </div>
          <button
            onClick={startEdit}
            className="shrink-0 px-3.5 py-2 rounded-lg text-xs text-zinc-300 border border-zinc-600 hover:border-zinc-400 hover:text-white transition"
          >
            更新表现
          </button>
        </div>
      </div>
    )
  }

  // ── 未记录态 / 编辑态 ──
  return (
    <div className="mt-8 rounded-xl border border-zinc-700/60 bg-zinc-800/30 px-6 py-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <span>📊</span> 发布表现如何？
          </h2>
          <p className="mt-1.5 text-xs text-zinc-400 leading-relaxed">
            这篇发布到平台后真实表现怎样？记录下来，系统能学会哪种选题和战略最适合你——这是灵感分析越用越准的关键一环。
          </p>
        </div>
        {performance && editing && (
          <button
            onClick={() => setEditing(false)}
            className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300 transition"
          >
            取消
          </button>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2 flex-wrap">
        {(Object.keys(GRADE_META) as Grade[]).map((g) => {
          const meta = GRADE_META[g]
          const active = grade === g
          return (
            <button
              key={g}
              type="button"
              onClick={() => setGrade(g)}
              className={`px-4 py-2 rounded-xl text-sm border transition ${
                active
                  ? meta.activeClass
                  : 'bg-zinc-800/50 border-zinc-700 text-zinc-300 hover:border-zinc-500'
              }`}
            >
              <span className="mr-1.5">{meta.emoji}</span>
              {meta.label}
            </button>
          )
        })}
      </div>

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform | '')}
          className="px-3 py-2 rounded-lg text-xs bg-zinc-800/60 border border-zinc-700 text-zinc-300 focus:outline-none focus:border-zinc-500"
        >
          <option value="">发布平台（可选）</option>
          {PLATFORM_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={200}
        rows={2}
        placeholder="补充说明（可选）：比如完播率比平时高、评论区在讨论某个点…"
        className="mt-3 w-full px-3.5 py-2.5 rounded-lg text-xs bg-zinc-800/60 border border-zinc-700 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 resize-none"
      />

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={!grade || saving}
          className="px-5 py-2.5 rounded-xl text-sm font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          {saving ? '记录中…' : performance ? '更新记录' : '记录表现'}
        </button>
        <span className="text-[11px] text-zinc-600">仅自己可见，用于个性化分析</span>
      </div>
    </div>
  )
}
