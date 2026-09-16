'use client'

// 作品详情页 → 灵感广场分享弹窗
// 三种模式：分享作品 / 分享灵感 / 分享完整创作档案（默认推荐）
// 档案快照由服务端构建，用户只需选择模式 + 可选编辑灵感起点/作者总结，30 秒内完成分享。

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export type ShareMode = 'work' | 'inspiration' | 'archive'

interface ShareToPlazaModalProps {
  open: boolean
  onClose: () => void
  projectId: string
  title: string
  versionCount: number
  /** 灵感起点默认文案（由作品蓝图/主题派生，用户可改） */
  defaultInspiration: string
  onPosted?: (postId: string, mode: ShareMode) => void
}

const MODES: Array<{
  key: ShareMode
  emoji: string
  name: string
  desc: string
  badge?: string
}> = [
  {
    key: 'archive',
    emoji: '📖',
    name: '分享完整创作档案',
    desc: '灵感起点 + AI 创作方向 + 版本迭代记录 + 最终作品，完整的创作者故事',
    badge: '推荐',
  },
  { key: 'work', emoji: '📄', name: '只分享作品', desc: '仅发布最终文章正文、标签与创作风格' },
  {
    key: 'inspiration',
    emoji: '💡',
    name: '只分享灵感',
    desc: '发布最初的创作想法、灵感来源与核心观点',
  },
]

export default function ShareToPlazaModal({
  open,
  onClose,
  projectId,
  title,
  versionCount,
  defaultInspiration,
  onPosted,
}: ShareToPlazaModalProps) {
  const router = useRouter()
  const [mode, setMode] = useState<ShareMode>('archive')
  const [inspiration, setInspiration] = useState('')
  const [authorSummary, setAuthorSummary] = useState('')
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [postedId, setPostedId] = useState<string | null>(null)

  // 每次打开重置为初始状态
  useEffect(() => {
    if (open) {
      setMode('archive')
      setInspiration(defaultInspiration)
      setAuthorSummary('')
      setTags('')
      setBusy(false)
      setError(null)
      setPostedId(null)
    }
  }, [open, defaultInspiration])

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  if (!open) return null

  const needInspiration = mode === 'archive' || mode === 'inspiration'
  const inspirationValid = inspiration.trim().length >= 5

  async function handlePublish() {
    if (busy) return
    if (needInspiration && !inspirationValid) {
      setError('请先填写灵感起点（至少 5 个字）')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) {
        setError('请先登录后再发布')
        setBusy(false)
        return
      }
      const res = await fetch('/api/posts/from-project', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          projectId,
          mode,
          ...(needInspiration ? { inspirationText: inspiration.trim() } : {}),
          ...(mode === 'archive' && authorSummary.trim()
            ? { authorSummary: authorSummary.trim() }
            : {}),
          ...(tags.trim() ? { tags: tags.trim() } : {}),
        }),
      })
      const data = (await res.json().catch(() => null)) as
        | { postId?: string; error?: string }
        | null
      if (!res.ok || !data?.postId) {
        setError(data?.error ?? '发布失败，请稍后重试')
        setBusy(false)
        return
      }
      setPostedId(data.postId)
      onPosted?.(data.postId, mode)
    } catch {
      setError('网络异常，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-full max-w-xl max-h-[90vh] overflow-y-auto dark-scroll rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-zinc-800/80 bg-zinc-950/95 backdrop-blur">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">发布到灵感广场</h2>
            <p className="text-xs text-zinc-500 mt-0.5 truncate max-w-sm">
              来自《{title}》· {versionCount} 个创作版本
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-zinc-500 hover:text-zinc-300 text-lg leading-none disabled:opacity-40"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {postedId ? (
          /* ── 发布成功 ── */
          <div className="px-6 py-10 text-center">
            <div className="text-4xl mb-3">🎉</div>
            <p className="text-sm text-zinc-200 font-medium">已发布到灵感广场</p>
            <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed">
              创作档案是发布瞬间的快照，之后作品继续迭代不会影响这条分享
            </p>
            <div className="mt-6 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => router.push(`/post/${postedId}`)}
                className="text-xs px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition"
              >
                查看分享内容 →
              </button>
              <button
                type="button"
                onClick={onClose}
                className="text-xs px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
              >
                留在本页
              </button>
            </div>
          </div>
        ) : (
          <div className="px-6 py-5 space-y-4">
            {/* 模式选择 */}
            <div className="space-y-2.5">
              {MODES.map((m) => {
                const selected = mode === m.key
                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setMode(m.key)}
                    className={`w-full text-left rounded-xl px-4 py-3 border transition flex items-start gap-3 ${
                      selected
                        ? 'border-indigo-500/60 bg-indigo-500/10'
                        : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                    }`}
                  >
                    <span className="text-xl leading-none mt-0.5">{m.emoji}</span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-200">{m.name}</span>
                        {m.badge && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                            {m.badge}
                          </span>
                        )}
                      </span>
                      <span className="block text-[11px] text-zinc-500 mt-1 leading-relaxed">
                        {m.desc}
                      </span>
                    </span>
                    <span
                      className={`mt-1 w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                        selected ? 'border-indigo-400 bg-indigo-500' : 'border-zinc-600'
                      }`}
                    >
                      {selected && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* 灵感起点（archive / inspiration 模式） */}
            {needInspiration && (
              <div>
                <label className="text-xs font-medium text-zinc-300">
                  {mode === 'archive' ? '① 灵感起点' : '灵感来源 / 创作初衷'}
                  <span className="text-zinc-600 font-normal ml-2">
                    为什么会想创作这个主题？
                  </span>
                </label>
                <textarea
                  value={inspiration}
                  onChange={(e) => setInspiration(e.target.value.slice(0, 2000))}
                  rows={4}
                  maxLength={2000}
                  placeholder="例如：看到身边朋友被裁员后的转变，想聊聊人在失败后如何重新定义自己……"
                  className="mt-2 w-full rounded-lg bg-zinc-900/70 border border-zinc-800 focus:border-indigo-500/60 px-3 py-2.5 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none resize-y dark-scroll"
                />
                <div className="flex justify-between mt-1">
                  <span className="text-[10px] text-zinc-600">
                    {mode === 'archive' && '已根据你的创作蓝图预填，可直接修改'}
                  </span>
                  <span className="text-[10px] text-zinc-600">{inspiration.length}/2000</span>
                </div>
              </div>
            )}

            {/* 作者总结（仅档案模式，选填） */}
            {mode === 'archive' && (
              <div>
                <label className="text-xs font-medium text-zinc-300">
                  ② 作者总结 <span className="text-zinc-600 font-normal">（选填）</span>
                </label>
                <textarea
                  value={authorSummary}
                  onChange={(e) => setAuthorSummary(e.target.value.slice(0, 500))}
                  rows={2}
                  maxLength={500}
                  placeholder="这次 AI 协作给你带来的最大启发？一句话写给其他创作者……"
                  className="mt-2 w-full rounded-lg bg-zinc-900/70 border border-zinc-800 focus:border-indigo-500/60 px-3 py-2.5 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none resize-y dark-scroll"
                />
              </div>
            )}

            {/* 标签（选填） */}
            <div>
              <label className="text-xs font-medium text-zinc-300">
                标签 <span className="text-zinc-600 font-normal">（选填，逗号分隔）</span>
              </label>
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="例如：人物成长, 创业故事"
                className="mt-2 w-full rounded-lg bg-zinc-900/70 border border-zinc-800 focus:border-indigo-500/60 px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none"
              />
            </div>

            {error && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            {/* 操作区 */}
            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="text-xs px-4 py-2 rounded-lg text-zinc-400 hover:text-zinc-200 transition disabled:opacity-40"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handlePublish}
                disabled={busy}
                className="text-xs px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
              >
                {busy && (
                  <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                )}
                {busy ? '发布中…' : '确认发布'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
