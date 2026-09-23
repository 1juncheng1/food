'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getValidSession } from '@/lib/supabaseClient'
import type {
  ClaimKind,
  KnowledgeItem,
  KnowledgeTrait,
} from '@/lib/creative/knowledgeItem'
import { extractKnowledgeTraits } from '@/lib/creative/knowledgeItem'
import {
  MATERIAL_TYPES,
  MATERIAL_TYPE_RULES,
  type Material,
  type MaterialGroup,
  type MaterialType,
  type MaterialSource,
} from '@/lib/creative/material'

type GroupFilter = 'all' | 'uncategorized' | string // string = group UUID

const SOURCE_OPTIONS: MaterialSource[] = ['手输', '上传', '外部链接', 'AI生成']

// 分组名 → 显示名兜底
function groupName(groups: MaterialGroup[], gid: string | null): string {
  if (!gid) return '未分组'
  const g = groups.find((x) => x.id === gid)
  return g ? g.name : '未分组'
}

// AI 理解是否过期（content 编辑后未重分析）
function isKnowledgeStale(m: Material): boolean {
  if (!m.knowledge?.analyzed_at) return false
  return new Date(m.updated_at).getTime() > new Date(m.knowledge.analyzed_at).getTime()
}

export default function MaterialsPage() {
  const router = useRouter()
  // P2-2：拆分 loading state，groups 与 materials 独立加载，先完成的先渲染
  const [loadingGroups, setLoadingGroups] = useState(true)
  const [loadingMaterials, setLoadingMaterials] = useState(true)
  // 兼容旧代码：loading 表示两者都完成
  const loading = loadingGroups || loadingMaterials
  const [loadError, setLoadError] = useState('')
  const [materials, setMaterials] = useState<Material[]>([])
  const [groups, setGroups] = useState<MaterialGroup[]>([])
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // 筛选状态
  const [selectedGroupId, setSelectedGroupId] = useState<GroupFilter>('all')
  const [typeFilter, setTypeFilter] = useState<MaterialType | ''>('')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  // 分组管理
  const [newGroupName, setNewGroupName] = useState('')
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [groupActionError, setGroupActionError] = useState('')

  // 编辑弹窗
  const [editing, setEditing] = useState<Material | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editType, setEditType] = useState<MaterialType>('其他')
  const [editGroupId, setEditGroupId] = useState<string | ''>('')
  const [editSource, setEditSource] = useState<MaterialSource>('手输')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState('')

  // AI 理解抽屉
  const [viewingAI, setViewingAI] = useState<Material | null>(null)

  // query debounce 300ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  // 初始化
  useEffect(() => {
    async function init() {
      const session = await getValidSession()
      if (!session) {
        router.replace('/login')
        return
      }
      // P2-2：groups 与 materials 并行启动，但各自独立 setLoading，先完成的先渲染
      // 不再 Promise.all 等两者都完成
      void fetchGroups()
      void fetchMaterials()
    }
    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])

  // 筛选条件变化时重新拉取
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    fetchMaterials()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId, typeFilter, debouncedQuery])

  async function fetchGroups() {
    setGroupActionError('')
    setLoadingGroups(true)
    try {
      const session = await getValidSession()
      if (!session) {
        router.replace('/login')
        return
      }
      const res = await fetch('/api/material-groups', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = await res.json()
      if (!res.ok) {
        setGroupActionError(data.error || '加载分组失败')
        return
      }
      setGroups(data.groups ?? [])
    } catch {
      setGroupActionError('网络错误，分组加载失败')
    } finally {
      setLoadingGroups(false)
    }
  }

  async function fetchMaterials() {
    setLoadError('')
    setLoadingMaterials(true)
    try {
      const session = await getValidSession()
      if (!session) {
        router.replace('/login')
        return
      }
      const params = new URLSearchParams()
      if (selectedGroupId && selectedGroupId !== 'all') {
        params.set('groupId', selectedGroupId)
      }
      if (typeFilter) params.set('type', typeFilter)
      if (debouncedQuery) params.set('q', debouncedQuery)
      const url = `/api/materials${params.toString() ? `?${params.toString()}` : ''}`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = await res.json()
      if (!res.ok) {
        setLoadError(data.error || '加载失败')
        return
      }
      setMaterials(data.materials ?? [])
    } catch {
      setLoadError('网络错误，加载失败')
    } finally {
      setLoadingMaterials(false)
    }
  }

  // ── 分组 CRUD ──
  async function handleCreateGroup() {
    const name = newGroupName.trim()
    if (!name) return
    setGroupActionError('')
    try {
      const session = await getValidSession()
      if (!session) {
        router.replace('/login')
        return
      }
      const res = await fetch('/api/material-groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      if (!res.ok) {
        setGroupActionError(data.error || '创建失败')
        return
      }
      setNewGroupName('')
      setCreatingGroup(false)
      await fetchGroups()
    } catch {
      setGroupActionError('网络错误，创建失败')
    }
  }

  async function handleRenameGroup(id: string) {
    const name = renameValue.trim()
    if (!name) return
    setGroupActionError('')
    try {
      const session = await getValidSession()
      if (!session) {
        router.replace('/login')
        return
      }
      const res = await fetch(`/api/material-groups/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      if (!res.ok) {
        setGroupActionError(data.error || '重命名失败')
        return
      }
      setRenamingId(null)
      setRenameValue('')
      await fetchGroups()
    } catch {
      setGroupActionError('网络错误，重命名失败')
    }
  }

  async function handleDeleteGroup(id: string, name: string) {
    if (!confirm(`确定删除分组「${name}」吗？该分组下素材会变成「未分组」，不会被删除。`)) return
    setGroupActionError('')
    try {
      const session = await getValidSession()
      if (!session) {
        router.replace('/login')
        return
      }
      const res = await fetch(`/api/material-groups/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = await res.json()
      if (!res.ok) {
        setGroupActionError(data.error || '删除失败')
        return
      }
      // 若当前选中分组被删，回退到「全部」
      if (selectedGroupId === id) setSelectedGroupId('all')
      await fetchGroups()
      await fetchMaterials()
    } catch {
      setGroupActionError('网络错误，删除失败')
    }
  }

  // ── 素材删除 ──
  async function handleDelete(id: string) {
    if (!confirm('确定要删除这条素材吗？')) return
    setDeletingId(id)
    try {
      const session = await getValidSession()
      if (!session) {
        router.replace('/login')
        return
      }
      const res = await fetch(`/api/scripts/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        setMaterials((prev) => prev.filter((m) => m.id !== id))
      } else {
        alert('删除失败，请重试')
      }
    } catch {
      alert('删除失败')
    } finally {
      setDeletingId(null)
    }
  }

  // ── AI 理解纠错：整块替换 knowledge（claims 删除 / 重新分析结果落库）──
  // knowledge jsonb 是 AI 理解的单一真源，claims 存在其内部，所以任何针对
  // 主张的修正都只能整体改写 knowledge，而不是给 claims 单开一个写接口。
  async function saveKnowledge(
    id: string,
    knowledge: KnowledgeItem
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const session = await getValidSession()
      if (!session) {
        router.replace('/login')
        return { ok: false, error: '登录已过期' }
      }
      const res = await fetch(`/api/scripts/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ knowledge }),
      })
      const data = await res.json()
      if (!res.ok) {
        return { ok: false, error: data.error || '保存失败' }
      }
      const updated = data.material
      // 列表与抽屉用同一份数据，只改一处会让抽屉读到旧 knowledge
      setMaterials((prev) => prev.map((m) => (m.id === id ? { ...m, ...updated } : m)))
      setViewingAI((prev) => (prev && prev.id === id ? { ...prev, ...updated } : prev))
      return { ok: true }
    } catch {
      return { ok: false, error: '网络错误，保存失败' }
    }
  }

  // ── 编辑弹窗 ──
  function openEdit(m: Material) {
    setEditing(m)
    setEditContent(m.content || '')
    setEditType(m.material_type || '其他')
    setEditGroupId(m.group_id || '')
    setEditSource((m.source as MaterialSource) || '手输')
    setEditError('')
  }

  function closeEdit() {
    setEditing(null)
    setEditError('')
    setSavingEdit(false)
  }

  async function handleSaveEdit() {
    if (!editing) return
    if (!editContent.trim()) {
      setEditError('内容不能为空')
      return
    }
    setSavingEdit(true)
    setEditError('')
    try {
      const session = await getValidSession()
      if (!session) {
        router.replace('/login')
        return
      }
      const body: Record<string, unknown> = {
        content: editContent.trim(),
        materialType: editType,
        source: editSource,
      }
      // groupId：空字符串 → null（移出分组）；否则保留 UUID
      body.groupId = editGroupId || null
      const res = await fetch(`/api/scripts/${editing.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setEditError(data.error || '保存失败')
        setSavingEdit(false)
        return
      }
      // 保存成功：关闭弹窗 + 刷新列表（拉新 material 含新字段）
      closeEdit()
      await fetchMaterials()
    } catch {
      setEditError('网络错误，保存失败')
      setSavingEdit(false)
    }
  }

  // ── 渲染 ──
  return (
    <div className="inner-page gen-stage" data-mode="inspiration">
      <div className="inner-container">
        {/* ── 顶部 ── */}
        <div className="inner-header">
          <div>
            <Link href="/dashboard" className="inner-back">← 返回主页</Link>
            <h1 className="inner-header-title">我的素材</h1>
            <p className="inner-header-sub">
              管理你导入的原始文案，AI 生成时会自动学习这里的风格
            </p>
          </div>
          <Link
            href="/add"
            className="inner-signout"
            style={{
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              border: 'none',
              color: '#ffffff',
            }}
          >
            ＋ 添加素材
          </Link>
        </div>

        {groupActionError && (
          <div className="bg-red-500/10 text-red-400 text-sm rounded-lg p-3 mb-4">
            {groupActionError}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6">
          {/* ── 左侧分组侧栏 ── */}
          <aside className="glass anim-rise rounded-2xl p-4 h-fit">
            <div className="text-xs text-zinc-500 mb-3 px-2 tracking-wider">分组</div>
            <ul className="space-y-1">
              <li>
                <button
                  onClick={() => setSelectedGroupId('all')}
                  className={`w-full text-left text-sm px-3 py-2.5 rounded-lg transition flex items-center justify-between ${
                    selectedGroupId === 'all'
                      ? 'bg-indigo-500/20 text-white border border-indigo-500/40'
                      : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200 border border-transparent'
                  }`}
                >
                  <span>全部</span>
                  <span className="text-[11px] text-zinc-500">{materials.length}</span>
                </button>
              </li>
              <li>
                <button
                  onClick={() => setSelectedGroupId('uncategorized')}
                  className={`w-full text-left text-sm px-3 py-2.5 rounded-lg transition flex items-center justify-between ${
                    selectedGroupId === 'uncategorized'
                      ? 'bg-indigo-500/20 text-white border border-indigo-500/40'
                      : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200 border border-transparent'
                  }`}
                >
                  <span>未分组</span>
                </button>
              </li>
              {groups.map((g) => {
                const isSel = selectedGroupId === g.id
                const isRenaming = renamingId === g.id
                return (
                  <li key={g.id} className="group">
                    {isRenaming ? (
                      <div className="flex items-center gap-1 px-1">
                        <input
                          autoFocus
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameGroup(g.id)
                            if (e.key === 'Escape') {
                              setRenamingId(null)
                              setRenameValue('')
                            }
                          }}
                          className="flex-1 bg-zinc-900/70 border border-indigo-500/40 rounded-md px-2 py-1.5 text-xs text-white outline-none"
                          placeholder="新分组名"
                        />
                        <button
                          onClick={() => handleRenameGroup(g.id)}
                          className="text-[11px] text-indigo-300 hover:text-indigo-200 px-1"
                          title="确认"
                        >
                          ✓
                        </button>
                        <button
                          onClick={() => {
                            setRenamingId(null)
                            setRenameValue('')
                          }}
                          className="text-[11px] text-zinc-500 hover:text-zinc-400 px-1"
                          title="取消"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div
                        className={`flex items-center justify-between rounded-lg transition border ${
                          isSel
                            ? 'bg-indigo-500/20 text-white border-indigo-500/40'
                            : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200 border-transparent'
                        }`}
                      >
                        <button
                          onClick={() => setSelectedGroupId(g.id)}
                          className="flex-1 text-left text-sm px-3 py-2.5 truncate"
                          title={g.name}
                        >
                          {g.name}
                        </button>
                        <div className="flex items-center pr-2 opacity-0 group-hover:opacity-100 transition">
                          <button
                            onClick={() => {
                              setRenamingId(g.id)
                              setRenameValue(g.name)
                            }}
                            className="text-[11px] text-zinc-500 hover:text-indigo-300 px-1"
                            title="重命名"
                          >
                            ✎
                          </button>
                          <button
                            onClick={() => handleDeleteGroup(g.id, g.name)}
                            className="text-[11px] text-zinc-500 hover:text-red-400 px-1"
                            title="删除"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>

            {/* 新建分组 */}
            <div className="mt-3 pt-3 border-t border-white/5">
              {creatingGroup ? (
                <div className="space-y-2">
                  <input
                    autoFocus
                    type="text"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreateGroup()
                      if (e.key === 'Escape') {
                        setNewGroupName('')
                        setCreatingGroup(false)
                      }
                    }}
                    placeholder="新分组名（最多 30 字）"
                    maxLength={30}
                    className="w-full bg-zinc-900/70 border border-indigo-500/40 rounded-lg px-3 py-2 text-sm text-white outline-none"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleCreateGroup}
                      className="flex-1 text-xs py-1.5 rounded-lg bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/30 transition"
                    >
                      确认新建
                    </button>
                    <button
                      onClick={() => {
                        setNewGroupName('')
                        setCreatingGroup(false)
                      }}
                      className="text-xs px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-500 hover:text-zinc-300 transition"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setCreatingGroup(true)}
                  className="w-full text-xs text-zinc-500 hover:text-indigo-300 border border-dashed border-zinc-700 hover:border-indigo-500/40 rounded-lg py-2.5 transition"
                >
                  ＋ 新建分组
                </button>
              )}
            </div>
          </aside>

          {/* ── 右侧主区 ── */}
          <section>
            {/* 搜索 + 类型筛选 */}
            <div className="glass anim-rise rounded-2xl p-4 mb-5 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索素材内容…"
                  className="w-full bg-zinc-900/60 border border-zinc-800 rounded-lg px-4 py-2.5 text-sm text-white outline-none focus:border-indigo-500/50"
                />
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 text-xs px-2"
                  >
                    ✕
                  </button>
                )}
              </div>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as MaterialType | '')}
                className="bg-zinc-900/60 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-white outline-none focus:border-indigo-500/50 cursor-pointer"
              >
                <option value="">全部类型</option>
                {MATERIAL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            {/* 列表区标题 */}
            <div className="inner-section-head">
              <h2 className="inner-section-title">
                {selectedGroupId === 'all'
                  ? '全部素材'
                  : selectedGroupId === 'uncategorized'
                  ? '未分组'
                  : groupName(groups, selectedGroupId)}
              </h2>
              {!loading && (
                <span className="inner-section-count">共 {materials.length} 条</span>
              )}
            </div>

            {loadError && (
              <div className="bg-red-500/10 text-red-400 text-sm rounded-lg p-3 mb-4">
                {loadError}
                <button
                  onClick={fetchMaterials}
                  className="ml-2 underline hover:text-red-300"
                >
                  重试
                </button>
              </div>
            )}

            {/* 列表 */}
            {loading ? (
              <div className="inner-list">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="inner-item" style={{ height: 100 }} />
                ))}
              </div>
            ) : materials.length === 0 ? (
              !loadError && (
                <div className="inner-empty">
                  <p>{query || typeFilter ? '没有匹配的素材' : '这里还没有素材'}</p>
                  <p className="sub">
                    {query || typeFilter
                      ? '试着换一个关键词或类型筛选'
                      : '点击右上角「添加素材」，粘贴几段你喜欢的文案开始建立风格库'}
                  </p>
                </div>
              )
            ) : (
              <div className="inner-list">
                {materials.map((m) => {
                  const mt = m.material_type
                  const mtRule = mt ? MATERIAL_TYPE_RULES[mt] : null
                  return (
                    <div key={m.id} className="inner-item anim-rise">
                      {/* 顶部行 */}
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2 text-xs flex-wrap">
                          <span
                            className="material-type-badge"
                            data-mt={mt || '其他'}
                          >
                            {mt || '未分类'}
                          </span>
                          <span className="inner-item-tag">
                            {groupName(groups, m.group_id)}
                          </span>
                          {m.type === 'image' && (
                            <span
                              className="inner-item-tag"
                              style={{
                                background: 'rgba(129, 140, 248, 0.15)',
                                color: '#a5b4fc',
                              }}
                            >
                              图片
                            </span>
                          )}
                          {m.source && (
                            <span className="inner-item-tag">来源：{m.source}</span>
                          )}
                          <span className="inner-item-date">
                            {new Date(m.created_at).toLocaleDateString('zh-CN')}
                          </span>
                          {isKnowledgeStale(m) && (
                            <span className="material-stale-badge">
                              AI 理解可能过时
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs shrink-0">
                          <button
                            onClick={() => setViewingAI(m)}
                            className="text-zinc-500 hover:text-indigo-300 transition"
                          >
                            {m.knowledge ? '查看 AI 理解' : 'AI 未分析'}
                          </button>
                          <button
                            onClick={() => openEdit(m)}
                            className="text-zinc-500 hover:text-indigo-300 transition"
                          >
                            编辑
                          </button>
                          <button
                            onClick={() => handleDelete(m.id)}
                            disabled={deletingId === m.id}
                            className="text-zinc-500 hover:text-red-400 disabled:opacity-50 transition"
                          >
                            {deletingId === m.id ? '删除中…' : '删除'}
                          </button>
                        </div>
                      </div>

                      {/* 中间：content 前 160 字 */}
                      <p className="inner-item-desc" style={{ marginTop: 10 }}>
                        {m.content && m.content.length > 160
                          ? m.content.slice(0, 160) + '…'
                          : m.content || '(无内容)'}
                      </p>

                      {/* 底部使用规则提示（若有 materialType） */}
                      {mtRule && (
                        <p className="text-[11px] text-zinc-600 mt-2 italic">
                          使用规则：{mtRule.usageRule}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* ── 编辑弹窗 ── */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
          onClick={closeEdit}
        >
          <div
            className="glass material-edit-modal rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto dark-scroll"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-white">编辑素材</h3>
              <button
                onClick={closeEdit}
                className="text-zinc-500 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            <div className="space-y-5">
              {/* content */}
              <div>
                <label className="gen-field-label text-left block mb-2">内容</label>
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={8}
                  className="w-full bg-zinc-900/60 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-indigo-500/50 resize-y"
                  style={{ lineHeight: 1.7 }}
                  placeholder="素材原文"
                />
                <p className="text-[11px] text-zinc-500 mt-1.5">
                  编辑内容后 AI 理解可能过时，需要手动重新分析（Phase 2 暂不自动重分析）
                </p>
              </div>

              {/* materialType 9 选 1 */}
              <div>
                <label className="gen-field-label text-left block mb-2">素材类型</label>
                <div className="flex flex-wrap gap-2">
                  {MATERIAL_TYPES.map((t) => {
                    const sel = editType === t
                    const rule = MATERIAL_TYPE_RULES[t]
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setEditType(t)}
                        data-active={sel || undefined}
                        className={`material-type-badge cursor-pointer transition ${
                          sel ? 'ring-1 ring-offset-2 ring-offset-zinc-900' : ''
                        }`}
                        data-mt={t}
                        title={rule.usageRule}
                      >
                        {rule.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* 分组下拉 */}
              <div>
                <label className="gen-field-label text-left block mb-2">分组</label>
                <select
                  value={editGroupId}
                  onChange={(e) => setEditGroupId(e.target.value)}
                  className="w-full bg-zinc-900/60 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-indigo-500/50 cursor-pointer"
                >
                  <option value="">不分组</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* 来源下拉 */}
              <div>
                <label className="gen-field-label text-left block mb-2">来源</label>
                <select
                  value={editSource}
                  onChange={(e) => setEditSource(e.target.value as MaterialSource)}
                  className="w-full bg-zinc-900/60 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-indigo-500/50 cursor-pointer"
                >
                  {SOURCE_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              {editError && (
                <p className="text-red-400 text-sm text-center">{editError}</p>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeEdit}
                  className="px-5 py-2.5 rounded-xl text-sm border border-zinc-700 text-zinc-400 hover:border-zinc-600 transition"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={savingEdit}
                  className="flex-1 btn-shine bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2.5 rounded-xl transition"
                >
                  {savingEdit ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── AI 理解抽屉 ── */}
      {viewingAI && (
        <AIKnowledgeDrawer
          material={viewingAI}
          groupName={groupName(groups, viewingAI.group_id)}
          onClose={() => setViewingAI(null)}
          onSaveKnowledge={saveKnowledge}
        />
      )}
    </div>
  )
}

// ── AI 理解抽屉子组件 ──
function AIKnowledgeDrawer({
  material,
  groupName,
  onClose,
  onSaveKnowledge,
}: {
  material: Material
  groupName: string
  onClose: () => void
  onSaveKnowledge: SaveKnowledgeFn
}) {
  const k: KnowledgeItem | null = material.knowledge
  const traits: KnowledgeTrait[] = k ? extractKnowledgeTraits(k) : []
  const mtRule = material.material_type
    ? MATERIAL_TYPE_RULES[material.material_type]
    : null
  const stale = isKnowledgeStale(material)

  // 点击遮罩关闭
  function onBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={onBackdropClick}
    >
      <aside
        className="material-drawer glass fixed right-0 top-0 h-full w-full sm:w-[440px] z-50 overflow-y-auto dark-scroll"
        style={{ borderRadius: '0' }}
      >
        <div className="p-6 space-y-5">
          {/* 抽屉头 */}
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-white">AI 理解</h3>
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-white text-sm"
            >
              ✕
            </button>
          </div>

          {/* 元数据条 */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className="material-type-badge"
              data-mt={material.material_type || '其他'}
            >
              {material.material_type || '未分类'}
            </span>
            <span className="inner-item-tag">{groupName}</span>
            {stale && <span className="material-stale-badge">AI 理解可能过时</span>}
          </div>

          {/* 主体 */}
          {!k ? (
            <div className="glass rounded-xl px-5 py-8 text-center">
              <p className="text-sm text-zinc-300">该素材尚未 AI 分析</p>
              <p className="text-xs text-zinc-500 mt-2">
                添加时若 AI 分析不可用，或素材为 legacy 数据，knowledge 字段为空
              </p>
            </div>
          ) : (
            <>
              {/* 摘要 */}
              <div>
                <p className="text-xs text-zinc-500 mb-2 tracking-wider">摘要</p>
                <div className="glass rounded-xl px-4 py-3 text-sm text-zinc-200 leading-relaxed">
                  {material.ai_summary || k.meaning}
                </div>
              </div>

              {/* 使用场景 */}
              {k.context && (
                <div>
                  <p className="text-xs text-zinc-500 mb-2 tracking-wider">使用场景</p>
                  <p className="text-sm text-zinc-300 leading-relaxed">{k.context}</p>
                </div>
              )}

              {/* 创作用途 */}
              {k.creation_usage && (
                <div>
                  <p className="text-xs text-zinc-500 mb-2 tracking-wider">创作用途</p>
                  <p className="text-sm text-zinc-300 leading-relaxed">
                    {k.creation_usage}
                  </p>
                </div>
              )}

              {/* 知识主张：这条素材到底说了什么 */}
              <ClaimsBlock
                material={material}
                knowledge={k}
                onSaveKnowledge={onSaveKnowledge}
              />

              {/* materialType 使用规则 */}
              {mtRule && (
                <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-4 py-3">
                  <p className="text-[11px] text-indigo-300 mb-1 tracking-wider">
                    {mtRule.label} · 使用规则
                  </p>
                  <p className="text-sm text-zinc-200">{mtRule.usageRule}</p>
                </div>
              )}

              {/* 相关主题（标签云） */}
              {material.related_topics && material.related_topics.length > 0 && (
                <div>
                  <p className="text-xs text-zinc-500 mb-2 tracking-wider">相关主题</p>
                  <div className="flex flex-wrap gap-2">
                    {material.related_topics.map((t) => (
                      <span
                        key={t}
                        className="text-xs px-2.5 py-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 6 维标签 */}
              {traits.length > 0 && (
                <div>
                  <p className="text-xs text-zinc-500 mb-3 tracking-wider">6 维标签</p>
                  <div className="space-y-3">
                    {traits.map((t) => (
                      <div key={t.dimension} className="flex items-start gap-2 flex-wrap">
                        <span className="text-[11px] text-zinc-500 w-16 shrink-0 pt-0.5">
                          {t.label}
                        </span>
                        <div className="flex flex-wrap gap-1.5 flex-1">
                          {t.tags.map((tag) => (
                            <span
                              key={tag}
                              className="text-[11px] px-2 py-0.5 rounded-full border border-zinc-700/60 bg-white/5 text-zinc-300"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 置信度 + 分析时间 */}
              <div className="text-[11px] text-zinc-600 pt-2 border-t border-white/5">
                置信度 {Math.round((k.confidence ?? 0) * 100)}% · 分析于{' '}
                {new Date(k.analyzed_at).toLocaleString('zh-CN')}
                {k.ai_model && ` · ${k.ai_model}`}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

// ── 知识主张区块 ───────────────────────────────────────────
//
// claims 回答的是「这条素材到底说了什么」，与下面的 6 维标签（它是什么类型）
// 是两个层面的东西，所以单独成块并支持纠错。
// 每条主张都带来源 + 可信度 + 适用场景，让创作者能判断能不能引用。

type SaveKnowledgeFn = (
  id: string,
  knowledge: KnowledgeItem
) => Promise<{ ok: boolean; error?: string }>

const CLAIM_KIND_STYLE: Record<ClaimKind, string> = {
  事实: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  数据: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  观点: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  经历: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
}

function ClaimsBlock({
  material,
  knowledge,
  onSaveKnowledge,
}: {
  material: Material
  knowledge: KnowledgeItem
  onSaveKnowledge: SaveKnowledgeFn
}) {
  const claims = knowledge.claims ?? []
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [openCorrect, setOpenCorrect] = useState(false)
  const [correction, setCorrection] = useState('')

  async function applyKnowledge(next: KnowledgeItem): Promise<boolean> {
    setBusy(true)
    setError('')
    const r = await onSaveKnowledge(material.id, next)
    setBusy(false)
    if (!r.ok) setError(r.error || '保存失败')
    return r.ok
  }

  // 删除是直接可用的最小纠错单位：这条主张抽错了或不是我的意思，去掉即可，
  // 不必为了一条主张重跑整次 LLM 分析。
  async function handleDelete(index: number) {
    if (busy) return
    const nextClaims = claims.filter((_, i) => i !== index)
    await applyKnowledge({ ...knowledge, claims: nextClaims })
  }

  // 整次重新分析：说法错了/抽漏了时才值得花一次 LLM 调用
  async function handleReAnalyze() {
    const text = correction.trim()
    if (!text || busy) return
    setBusy(true)
    setError('')
    try {
      const session = await getValidSession()
      if (!session) {
        setError('登录已过期，请重新登录')
        return
      }
      const res = await fetch('/api/creative/analyze-knowledge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          content: material.content,
          mode: 're_analyze',
          previous_knowledge: knowledge,
          correction: text,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || '重新分析失败')
        return
      }
      const ok = await applyKnowledge(data.knowledge)
      if (ok) {
        setCorrection('')
        setOpenCorrect(false)
      }
    } catch {
      setError('网络错误，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p className="text-xs text-zinc-500 mb-2 tracking-wider">知识主张</p>

      {claims.length === 0 ? (
        <p className="text-xs text-zinc-600 leading-relaxed">
          这条素材暂未提炼出可引用的事实 / 数据 / 观点 / 经历
        </p>
      ) : (
        <div className="space-y-2">
          {claims.map((c, i) => (
            <div key={c.text} className="glass rounded-xl px-3.5 py-3">
              <div className="flex items-start gap-2">
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${
                    CLAIM_KIND_STYLE[c.kind] ?? CLAIM_KIND_STYLE['观点']
                  }`}
                >
                  {c.kind}
                </span>
                <p className="text-sm text-zinc-200 leading-relaxed flex-1">{c.text}</p>
                <button
                  onClick={() => handleDelete(i)}
                  disabled={busy}
                  className="text-[10px] text-zinc-600 hover:text-red-400 transition shrink-0 disabled:opacity-40"
                >
                  删除
                </button>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
                <span>可信度 {Math.round((c.confidence ?? 0) * 100)}%</span>
                {c.source && <span>· 来源：{c.source}</span>}
                {c.applicableScopes?.map((s) => (
                  <span
                    key={s}
                    className="px-1.5 py-0.5 rounded-full border border-zinc-700/60 bg-white/5"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 纠错入口 */}
      <div className="mt-3">
        {!openCorrect ? (
          <button
            onClick={() => setOpenCorrect(true)}
            className="text-[11px] text-indigo-400 hover:text-indigo-300 transition"
          >
            纠正理解
          </button>
        ) : (
          <div className="space-y-2">
            <textarea
              value={correction}
              onChange={(e) => setCorrection(e.target.value)}
              rows={3}
              disabled={busy}
              placeholder="说明 AI 哪里理解错了，例如：这不是事实，是我的个人观察 / 漏掉了「…」这组数据 / 这个观点我说反了"
              className="w-full rounded-lg bg-white/5 border border-zinc-700/60 px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50 disabled:opacity-60"
            />
            <div className="flex items-center gap-3">
              <button
                onClick={handleReAnalyze}
                disabled={busy || !correction.trim()}
                className="text-[11px] px-3 py-1.5 rounded-lg bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 disabled:opacity-40"
              >
                {busy ? '处理中…' : '重新分析'}
              </button>
              <button
                onClick={() => {
                  setOpenCorrect(false)
                  setCorrection('')
                  setError('')
                }}
                disabled={busy}
                className="text-[11px] text-zinc-500 hover:text-zinc-300"
              >
                取消
              </button>
            </div>
          </div>
        )}

        {error && <p className="text-[11px] text-red-400 mt-2">{error}</p>}
      </div>
    </div>
  )
}
