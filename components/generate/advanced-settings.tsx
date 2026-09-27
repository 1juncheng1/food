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

  const restoreAppliedRef = useRef(false)

  // 初始化：错误恢复回填角色勾选
  useEffect(() => {
    const init = async () => {
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
    <div className="vs-sec">
      {/* 折叠头 */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-start justify-between gap-4 text-left"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="vs-mark">登场角色</span>
          <span className="vs-note">
            最多 {MAX_CHARACTERS_PER_GENERATION} 个，AI 会严格按设定写进故事
          </span>
        </span>
        <span
          className={`vs-note inline-block transition-transform duration-300 ${
            open ? 'rotate-180' : ''
          }`}
        >
          ▾
        </span>
      </button>

      {/* 折叠体（保持挂载以保留内部状态，仅视觉隐藏） */}
      <div className={open ? '' : 'hidden'}>
        <div className="pt-4 space-y-4">
          {characters.length === 0 ? (
            <div className="text-center">
              <p className="vs-note leading-relaxed">
                还没有角色。创建后 AI 会严格按其设定写进故事，并可跨作品复用
              </p>
              <div className="flex flex-wrap justify-center gap-3 mt-3">
                <button
                  type="button"
                  onClick={() => openCharModal(null)}
                  className="vs-btn vs-btn-ghost"
                >
                  创建角色
                </button>
                <button type="button" onClick={openSelfModal} className="vs-btn vs-btn-primary">
                  把「我」写进故事
                </button>
              </div>
              <p className="vs-note mt-2">
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
                    className={`text-left p-4 rounded-[var(--vs-r)] border cursor-pointer transition ${
                      selected
                        ? 'border-[var(--vs-beam-line)] bg-[var(--vs-beam-wash)]'
                        : 'border-[var(--vs-line)] bg-transparent hover:border-[var(--vs-line-2)]'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-[15px] text-[var(--vs-ink)]">
                        {c.name}
                      </span>
                      {c.is_self && <span className="vs-verdict">我</span>}
                      <span className="vs-verdict">
                        {CHARACTER_ROLE_LABELS[c.role].split(' ')[0]}
                      </span>
                    </div>
                    <p className="vs-note mt-1.5 truncate">
                      {c.background || c.personality || '暂无设定，点「编辑」补充'}
                    </p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          openCharModal(c)
                        }}
                        className="vs-link"
                        title="编辑此角色"
                      >
                        编辑
                      </button>
                      {selected && <span className="vs-note">已登场</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {charNote && <p className="vs-note vs-note-warn mt-2">{charNote}</p>}
        </div>
      </div>

      {/* ── 角色管理 modal（置于折叠区外，避免 Enter 误触） ── */}
      {charModalOpen && (
        <div className="vs-overlay">
          <div className="absolute inset-0" onClick={() => setCharModalOpen(false)} />
          <div className="vs-modal space-y-4">
            <div className="flex items-center justify-between gap-4">
              <h2 className="vs-h3">{editingChar ? '编辑角色' : '新建角色'}</h2>
              <button
                type="button"
                onClick={() => setCharModalOpen(false)}
                className="vs-link"
              >
                关闭
              </button>
            </div>

            {charError && <div className="vs-error">{charError}</div>}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text" value={cName} onChange={(e) => setCName(e.target.value)}
                placeholder="角色名（≤30 字）" maxLength={30}
                className="vs-input vs-input-field"
              />
              <select
                value={cRole} onChange={(e) => setCRole(e.target.value as CharacterRole)}
                className="vs-select"
              >
                {CHARACTER_ROLES.map((r) => (
                  <option key={r} value={r}>{CHARACTER_ROLE_LABELS[r]}</option>
                ))}
              </select>
            </div>

            <button
              type="button" onClick={() => setCIsSelf(!cIsSelf)}
              className={`w-full flex items-center gap-2.5 text-left rounded-[var(--vs-r)] border px-3 py-2.5 text-[14px] transition ${
                cIsSelf
                  ? 'border-[var(--vs-beam-line)] bg-[var(--vs-beam-wash)] text-[var(--vs-ink)]'
                  : 'border-[var(--vs-line)] bg-transparent text-[var(--vs-ink-3)] hover:border-[var(--vs-line-2)]'
              }`}
            >
              <span
                className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center text-[10px] ${
                  cIsSelf
                    ? 'border-[var(--vs-beam)] bg-[var(--vs-beam)] text-[#0a0c10]'
                    : 'border-[var(--vs-line-2)]'
                }`}
              >
                {cIsSelf ? '✓' : ''}
              </span>
              这是我本人（AI 会格外谨慎，不虚构你的真实经历）
            </button>

            {cIsSelf && (
              <div className="vs-sec space-y-2">
                <div className="flex flex-wrap items-end gap-3">
                  <input
                    type="text" value={cHint} onChange={(e) => setCHint(e.target.value)}
                    placeholder="补充一句你的身份信息（可选）" maxLength={100}
                    className="vs-input vs-input-field flex-1 min-w-[160px]"
                  />
                  <button
                    type="button" onClick={handleSelfDraft} disabled={drafting}
                    className="vs-btn vs-btn-ghost disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {drafting ? '生成中…' : 'AI 起稿'}
                  </button>
                </div>
                <p className="vs-note leading-relaxed">
                  基于你的创作者报告生成草稿，生成后可自由修改；材料不足时会提示你先补充，AI 不会编造你的职业、年龄等具体事实
                </p>
              </div>
            )}

            <textarea
              value={cBackground} onChange={(e) => setCBackground(e.target.value)}
              placeholder="身份背景：职业 / 经历 / 年龄等（≤200 字）" maxLength={200} rows={3}
              className="vs-input vs-input-area resize-none"
            />
            <textarea
              value={cPersonality} onChange={(e) => setCPersonality(e.target.value)}
              placeholder="性格特质与说话方式（≤200 字）" maxLength={200} rows={3}
              className="vs-input vs-input-area resize-none"
            />

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button" onClick={handleSaveChar} disabled={savingChar}
                className="vs-btn vs-btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {savingChar ? '保存中…' : '保存'}
              </button>
              <button
                type="button"
                onClick={() => setCharModalOpen(false)}
                className="vs-btn vs-btn-ghost"
              >
                取消
              </button>
              {editingChar && (
                <button
                  type="button"
                  onClick={handleDeleteChar}
                  className="vs-link-danger ml-auto"
                >
                  删除
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
