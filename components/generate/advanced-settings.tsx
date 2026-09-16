'use client'

// ============================================================
// 角色管理（原高级设置折叠区）—— 阶段 2 简化
//
// 阶段 2 删除了身份选择 / 文风 / 类型 / 字数 / 手动生成路径——
// 这些全部由 AI 方案推断，用户不再手动传递。
//
// 只保留登场角色：用户主动添加的角色是内容约束（不是风格约束），
// AI 会严格按其设定写进故事。
// ============================================================

import { useEffect, useRef, useState } from 'react'
import {
  getStyleMemory,
} from '@/lib/styleMemory'
import { supabase } from '@/lib/supabaseClient'
import {
  CHARACTER_ROLE_LABELS,
  CHARACTER_ROLES,
  MAX_CHARACTERS_PER_GENERATION,
  type CharacterRole,
  type CharacterSnapshot,
  type UserCharacter,
} from '@/lib/characters'

/** 角色管理快照（父页面生成/分析时读取） */
export interface AdvancedSettingsValue {
  characters: CharacterSnapshot[]
  selectedCharIds: string[]
}

/** sessionStorage 错误恢复时回填的字段（仅角色相关） */
export interface RestoreSettings {
  charIds?: string[]
}

interface AdvancedSettingsProps {
  isLoggedIn: boolean
  open: boolean
  onToggle: () => void
  onChange: (v: AdvancedSettingsValue) => void
  restore?: RestoreSettings | null
}

export function AdvancedSettings({
  isLoggedIn,
  open,
  onToggle,
  onChange,
  restore,
}: AdvancedSettingsProps) {
  const [characters, setCharacters] = useState<UserCharacter[]>([])
  const [selectedCharIds, setSelectedCharIds] = useState<string[]>([])
  const [charNote, setCharNote] = useState('')
  const [charModalOpen, setCharModalOpen] = useState(false)
  const [editingChar, setEditingChar] = useState<UserCharacter | null>(null)
  const [cName, setCName] = useState('')
  const [cBackground, setCBackground] = useState('')
  const [cPersonality, setCPersonality] = useState('')
  const [cRole, setCRole] = useState<CharacterRole>('supporting')
  const [cIsSelf, setCIsSelf] = useState(false)
  const [cHint, setCHint] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [savingChar, setSavingChar] = useState(false)
  const [charError, setCharError] = useState('')
  const [memoryCount, setMemoryCount] = useState(0)

  const restoreAppliedRef = useRef(false)

  // 初始化：风格记忆计数 + 错误恢复回填角色勾选
  useEffect(() => {
    const init = async () => {
      setMemoryCount(getStyleMemory().length)
      if (!restore || restoreAppliedRef.current) return
      restoreAppliedRef.current = true
      // 角色库到达后回填恢复的勾选（过滤掉库中已不存在的 id）
      if (Array.isArray(restore.charIds)) {
        const validIds = new Set(characters.map((c: UserCharacter) => c.id))
        setSelectedCharIds(
          restore.charIds
            .filter((x) => typeof x === 'string' && validIds.has(x))
            .slice(0, MAX_CHARACTERS_PER_GENERATION)
        )
      }
    }
    void init()
  }, [restore])

  // 登录态下加载角色库（失败静默，不阻塞主流程）
  useEffect(() => {
    if (!isLoggedIn) return
    let cancelled = false
    ;(async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (!session?.access_token) return
        const res = await fetch('/api/characters', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (!res.ok || cancelled) return
        const d = await res.json()
        if (cancelled || !Array.isArray(d.characters)) return
        setCharacters(d.characters)
        // 角色到达后回填恢复的勾选（过滤掉库中已不存在的 id）
        if (Array.isArray(restore?.charIds)) {
          const validIds = new Set(d.characters.map((c: UserCharacter) => c.id))
          setSelectedCharIds(
            restore.charIds!
              .filter((x) => typeof x === 'string' && validIds.has(x))
              .slice(0, MAX_CHARACTERS_PER_GENERATION)
          )
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
    // restore 在挂载后不变，仅需随登录态执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn])

  // 快照同步给父页面（selectedCharIds 或 characters 变化时）
  useEffect(() => {
    const selectedChars: CharacterSnapshot[] = characters
      .filter((c) => selectedCharIds.includes(c.id))
      .map((c) => ({
        name: c.name,
        background: c.background,
        personality: c.personality,
        role: c.role,
        isSelf: c.is_self,
      }))

    onChange({
      characters: selectedChars,
      selectedCharIds,
    })
  }, [characters, selectedCharIds, onChange])

  // ── 角色 CRUD ──

  function toggleChar(id: string) {
    if (selectedCharIds.includes(id)) {
      setSelectedCharIds(selectedCharIds.filter((x) => x !== id))
      setCharNote('')
      return
    }
    if (selectedCharIds.length >= MAX_CHARACTERS_PER_GENERATION) {
      setCharNote(`每次生成最多登场 ${MAX_CHARACTERS_PER_GENERATION} 个角色`)
      return
    }
    setSelectedCharIds([...selectedCharIds, id])
    setCharNote('')
  }

  function openCharModal(char: UserCharacter | null) {
    setEditingChar(char)
    setCName(char?.name ?? '')
    setCBackground(char?.background ?? '')
    setCPersonality(char?.personality ?? '')
    setCRole(char?.role ?? 'supporting')
    setCIsSelf(char?.is_self ?? false)
    setCHint('')
    setCharError('')
    setCharModalOpen(true)
  }

  function openSelfModal() {
    openCharModal(null)
    setCName('我')
    setCIsSelf(true)
  }

  async function handleSelfDraft() {
    setDrafting(true)
    setCharError('')
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setCharError('请先登录')
        return
      }
      const res = await fetch('/api/characters/self-draft', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ hint: cHint }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok) {
        setCharError(d?.error ?? '草稿生成失败，请稍后重试')
        return
      }
      if (d?.draft?.background) setCBackground(d.draft.background)
      if (d?.draft?.personality) setCPersonality(d.draft.personality)
    } catch {
      setCharError('网络异常，请重试')
    } finally {
      setDrafting(false)
    }
  }

  async function handleSaveChar() {
    if (!cName.trim()) {
      setCharError('请填写角色名')
      return
    }
    setSavingChar(true)
    setCharError('')
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setCharError('请先登录')
        return
      }
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      }
      const payload = {
        name: cName.trim(),
        background: cBackground.trim(),
        personality: cPersonality.trim(),
        role: cRole,
        isSelf: cIsSelf,
      }
      const res = editingChar
        ? await fetch(`/api/characters/${editingChar.id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(payload),
          })
        : await fetch('/api/characters', {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
          })
      const d = await res.json().catch(() => null)
      if (!res.ok) {
        setCharError(d?.error ?? '保存失败，请重试')
        return
      }
      const saved = d.character as UserCharacter
      setCharacters((prev) =>
        editingChar
          ? prev.map((c) => (c.id === saved.id ? saved : c))
          : [saved, ...prev]
      )
      if (!editingChar) {
        setSelectedCharIds((prev) =>
          prev.includes(saved.id) || prev.length >= MAX_CHARACTERS_PER_GENERATION
            ? prev
            : [...prev, saved.id]
        )
      }
      setCharModalOpen(false)
    } catch {
      setCharError('网络异常，请重试')
    } finally {
      setSavingChar(false)
    }
  }

  async function handleDeleteChar() {
    if (!editingChar) return
    if (!confirm(`确定删除角色「${editingChar.name}」吗？已生成的作品不受影响`)) return
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setCharError('请先登录')
        return
      }
      const res = await fetch(`/api/characters/${editingChar.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        setCharError(d?.error ?? '删除失败，请重试')
        return
      }
      setCharacters((prev) => prev.filter((c) => c.id !== editingChar.id))
      setSelectedCharIds((prev) => prev.filter((x) => x !== editingChar.id))
      setCharModalOpen(false)
    } catch {
      setCharError('网络异常，请重试')
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden">
      {/* 折叠头 */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-5 py-4 text-left transition-colors hover:bg-zinc-900/50"
      >
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-300">登场角色</span>
          <span className="text-[11px] text-zinc-500">
            最多 {MAX_CHARACTERS_PER_GENERATION} 个，AI 会严格按设定写进故事
          </span>
        </span>
        <span className={`text-zinc-500 text-xs transition-transform duration-300 ${open ? 'rotate-180' : ''}`}>
          ▾
        </span>
      </button>

      {/* 折叠体（保持挂载以保留内部状态，仅视觉隐藏） */}
      <div className={open ? '' : 'hidden'}>
        <div className="px-5 pb-5 space-y-4 border-t border-zinc-800/70 pt-6">
          {characters.length === 0 ? (
            <div className="border border-dashed border-zinc-800 rounded-xl p-5 text-center">
              <p className="text-sm text-zinc-400">
                还没有角色。创建后 AI 会严格按其设定写进故事，并可跨作品复用
              </p>
              <div className="flex flex-wrap justify-center gap-3 mt-3">
                <button
                  type="button" onClick={() => openCharModal(null)}
                  className="text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-4 py-2 rounded-lg transition"
                >创建角色</button>
                <button
                  type="button" onClick={openSelfModal}
                  className="text-sm bg-indigo-600/80 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition"
                >把「我」写进故事</button>
              </div>
              <p className="text-[11px] text-zinc-600 mt-2">
                「我」角色可基于你的创作者报告由 AI 起稿，不会编造你的具体经历
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {characters.map((c) => {
                const selected = selectedCharIds.includes(c.id)
                return (
                  <div
                    key={c.id}
                    onClick={() => toggleChar(c.id)}
                    className={`relative text-left p-4 rounded-xl border cursor-pointer transition ${
                      selected
                        ? 'border-indigo-500 bg-indigo-600/10'
                        : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/60'
                    }`}
                  >
                    <div className="flex items-center gap-2 pr-5">
                      <span className="font-medium text-sm text-white">{c.name}</span>
                      {c.is_self && (
                        <span className="text-[10px] text-emerald-300 bg-emerald-500/15 px-1.5 py-0.5 rounded">
                          我
                        </span>
                      )}
                      <span className="text-[10px] text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded">
                        {CHARACTER_ROLE_LABELS[c.role].split(' ')[0]}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-500 mt-1.5 truncate">
                      {c.background || c.personality || '暂无设定，点击 ✎ 补充'}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); openCharModal(c) }}
                      className="absolute top-3 right-3 text-xs text-zinc-600 hover:text-indigo-300 transition"
                      title="编辑此角色"
                    >✎</button>
                    {selected && (
                      <span className="absolute bottom-2.5 right-3 text-[11px] text-indigo-300">
                        ✓ 已登场
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {charNote && <p className="text-xs text-amber-400 mt-2">{charNote}</p>}
        </div>
      </div>

      {/* ── 角色管理 modal（置于折叠区外，避免 Enter 误触） ── */}
      {charModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/70"
            onClick={() => setCharModalOpen(false)}
          />
          <div className="relative w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">
                {editingChar ? '编辑角色' : '新建角色'}
              </h2>
              <button
                type="button" onClick={() => setCharModalOpen(false)}
                className="text-zinc-500 hover:text-zinc-300 transition"
              >✕</button>
            </div>

            {charError && (
              <div className="bg-red-500/10 text-red-400 text-xs rounded-lg p-3 border border-red-500/20">
                {charError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text" value={cName} onChange={(e) => setCName(e.target.value)}
                placeholder="角色名 *（≤30 字）" maxLength={30}
                className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none transition"
              />
              <select
                value={cRole} onChange={(e) => setCRole(e.target.value as CharacterRole)}
                className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none transition"
              >
                {CHARACTER_ROLES.map((r) => (
                  <option key={r} value={r}>{CHARACTER_ROLE_LABELS[r]}</option>
                ))}
              </select>
            </div>

            <button
              type="button" onClick={() => setCIsSelf(!cIsSelf)}
              className={`w-full flex items-center gap-2.5 text-left rounded-lg border px-3 py-2.5 text-sm transition ${
                cIsSelf
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700'
              }`}
            >
              <span
                className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center text-[10px] ${
                  cIsSelf ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-zinc-600'
                }`}
              >{cIsSelf ? '✓' : ''}</span>
              这是我本人（AI 会格外谨慎，不虚构你的真实经历）
            </button>

            {cIsSelf && (
              <div className="space-y-2 bg-indigo-500/5 border border-indigo-500/20 rounded-xl p-3">
                <div className="flex gap-2">
                  <input
                    type="text" value={cHint} onChange={(e) => setCHint(e.target.value)}
                    placeholder="补充一句你的身份信息（可选）" maxLength={100}
                    className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none transition"
                  />
                  <button
                    type="button" onClick={handleSelfDraft} disabled={drafting}
                    className="shrink-0 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-2 rounded-lg transition"
                  >{drafting ? '生成中…' : 'AI 起稿'}</button>
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  基于你的创作者报告生成草稿，生成后可自由修改；材料不足时会提示你先补充，AI 不会编造你的职业、年龄等具体事实
                </p>
              </div>
            )}

            <textarea
              value={cBackground} onChange={(e) => setCBackground(e.target.value)}
              placeholder="身份背景：职业 / 经历 / 年龄等（≤200 字）" maxLength={200} rows={3}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none transition resize-none"
            />
            <textarea
              value={cPersonality} onChange={(e) => setCPersonality(e.target.value)}
              placeholder="性格特质与说话方式（≤200 字）" maxLength={200} rows={3}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none transition resize-none"
            />

            <div className="flex items-center gap-3 pt-1">
              <button
                type="button" onClick={handleSaveChar} disabled={savingChar}
                className="text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 rounded-lg transition"
              >{savingChar ? '保存中…' : '保存'}</button>
              <button
                type="button" onClick={() => setCharModalOpen(false)}
                className="text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-4 py-2 rounded-lg transition"
              >取消</button>
              {editingChar && (
                <button
                  type="button" onClick={handleDeleteChar}
                  className="ml-auto text-sm text-red-400 hover:text-red-300 transition"
                >删除</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
