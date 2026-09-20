'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase, getValidSession } from '@/lib/supabaseClient'
import type { KnowledgeItem } from '@/lib/creative/knowledgeItem'

interface ScriptItem {
  id: string
  content: string | null
  created_at: string
  type: string | null
  file_url: string | null
  category: string | null
  knowledge: KnowledgeItem | null
}

export default function MaterialsPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [scripts, setScripts] = useState<ScriptItem[]>([])
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    async function init() {
      const session = await getValidSession()
      if (!session) {
        router.replace('/login')
        return
      }
      await loadScripts()
      setLoading(false)
    }
    init()
  }, [router])

  async function loadScripts() {
    setLoadError('')
    const { data, error } = await supabase
      .from('scripts')
      .select('id, content, created_at, type, file_url, category, knowledge')
      .order('created_at', { ascending: false })
    if (error) {
      console.error('加载素材失败:', {
        code: error.code, message: error.message, details: error.details, hint: error.hint,
      })
      setLoadError('加载失败，请重试')
      return
    }
    setScripts(data ?? [])
  }

  async function handleDelete(id: string) {
    if (!confirm('确定要删除这条素材吗？')) return
    setDeletingId(id)
    try {
      const session = await getValidSession()
      if (!session) { router.replace('/login'); return }
      const res = await fetch(`/api/scripts/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        setScripts((prev) => prev.filter((s) => s.id !== id))
      } else {
        alert('删除失败，请重试')
      }
    } catch {
      alert('删除失败')
    } finally {
      setDeletingId(null)
    }
  }

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
          <Link href="/add" className="inner-signout" style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', border: 'none', color: '#ffffff' }}>
            ＋ 添加素材
          </Link>
        </div>

        {loadError && (
          <div className="bg-red-500/10 text-red-400 text-sm rounded-lg p-3 mb-6">
            {loadError}
            <button onClick={loadScripts} className="ml-2 underline hover:text-red-300">重试</button>
          </div>
        )}

        {/* ── 区块标题 ── */}
        <div className="inner-section-head">
          <h2 className="inner-section-title">素材列表</h2>
          {!loading && <span className="inner-section-count">共 {scripts.length} 条</span>}
        </div>

        {/* ── 列表 ── */}
        {loading ? (
          <div className="inner-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="inner-item" style={{ height: 80 }} />
            ))}
          </div>
        ) : scripts.length === 0 ? (
          !loadError && (
            <div className="inner-empty">
              <p>还没有素材</p>
              <p className="sub">点击右上角「添加素材」，粘贴几段你喜欢的文案开始建立风格库</p>
            </div>
          )
        ) : (
          <div className="inner-list">
            {scripts.map((s) => (
              <div key={s.id} className="inner-item">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 text-xs">
                    {/* 优先展示 AI 推断的 content_tags[0]，其次 content_type，最后老 category */}
                    <span className="inner-item-tag">
                      {s.knowledge?.content_tags?.[0]
                        ? s.knowledge.content_tags[0]
                        : s.knowledge?.content_type
                          ? s.knowledge.content_type
                          : s.category ?? '未分类'}
                    </span>
                    <span className="inner-item-tag" style={{ background: 'rgba(129, 140, 248, 0.15)', color: '#a5b4fc' }}>
                      {s.type === 'image' ? '图片' : '文本'}
                    </span>
                    <span className="inner-item-date">
                      {new Date(s.created_at).toLocaleDateString('zh-CN')}
                    </span>
                  </div>
                  <button
                    onClick={() => handleDelete(s.id)}
                    disabled={deletingId === s.id}
                    className="text-xs text-zinc-600 hover:text-red-400 disabled:opacity-50 transition shrink-0"
                  >
                    {deletingId === s.id ? '删除中...' : '删除'}
                  </button>
                </div>
                <p className="inner-item-desc" style={{ marginTop: 10 }}>
                  {s.content && s.content.length > 160
                    ? s.content.slice(0, 160) + '…'
                    : s.content}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
