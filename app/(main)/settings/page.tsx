'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import {
  InterviewDialog,
} from '@/components/creative/interview-dialog'
import {
  normalizeCreatorDeclaration,
  isDeclarationComplete,
  isDeclarationEmpty,
  extractDeclarationTraits,
  type CreatorDeclaration,
} from '@/lib/creative/creatorDeclaration'

// ────────────────────────────────────────────────────────────
// 设置页面：创作者访谈 + 隐私设置 + 数据导出
// 路径：/settings
// ────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // 隐私设置（localStorage）
  const [defaultPublic, setDefaultPublic] = useState(true)

  // 创作者访谈（settings 入口）
  const [interviewOpen, setInterviewOpen] = useState(false)
  const [declaration, setDeclaration] = useState<CreatorDeclaration>({})
  const [declLoading, setDeclLoading] = useState(true)

  // 导出状态
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // 昵称（auth.users.user_metadata.display_name，个人主页展示用）
  const [nickname, setNickname] = useState('')
  const [nicknameSaving, setNicknameSaving] = useState(false)
  const [nicknameMsg, setNicknameMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  /** 加载创作者声明（访谈结果） */
  async function loadDeclaration(token: string) {
    try {
      const res = await fetch('/api/creative/interview', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const json = await res.json()
      const decl = normalizeCreatorDeclaration(json.status?.declaration)
      setDeclaration(decl)
    } catch {
      // 静默失败
    } finally {
      setDeclLoading(false)
    }
  }

  useEffect(() => {
    async function init() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      setAccessToken(session.access_token)
      setLoading(true)
      await loadDeclaration(session.access_token)
      setLoading(false)

      // 读取已有昵称
      const metaName = session.user.user_metadata?.display_name
      if (typeof metaName === 'string') setNickname(metaName)

      // 读取本地隐私设置
      const stored = localStorage.getItem('default_public')
      if (stored !== null) setDefaultPublic(stored === 'true')
    }
    init()
  }, [])

  /** 切换隐私设置 */
  function handleTogglePublic() {
    const newVal = !defaultPublic
    setDefaultPublic(newVal)
    localStorage.setItem('default_public', String(newVal))
  }

  /** 保存昵称：写入 auth.users.user_metadata.display_name，主页 RPC 读取展示 */
  async function handleSaveNickname() {
    if (nicknameSaving) return
    const trimmed = nickname.trim()
    setNicknameSaving(true)
    setNicknameMsg(null)
    try {
      const { error } = await supabase.auth.updateUser({
        data: { display_name: trimmed },
      })
      if (error) {
        setNicknameMsg({ type: 'error', text: error.message })
      } else {
        setNickname(trimmed)
        setNicknameMsg({
          type: 'success',
          text: trimmed ? '昵称已保存' : '已清除昵称，主页将显示邮箱前缀',
        })
      }
    } catch {
      setNicknameMsg({ type: 'error', text: '网络异常，请稍后重试' })
    } finally {
      setNicknameSaving(false)
    }
  }

  /** 导出个人数据 */
  async function handleExport() {
    if (!accessToken || exporting) return
    setExporting(true)
    setExportMsg(null)
    try {
      const res = await fetch('/api/export-data', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setExportMsg({ type: 'error', text: err?.error ?? '导出失败' })
        return
      }
      // 触发文件下载
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      // 从 Content-Disposition 提取文件名，兜底用默认名
      const cd = res.headers.get('content-disposition') ?? ''
      const match = cd.match(/filename="?([^"]+)"?/)
      a.download = match?.[1] ?? `export-${Date.now()}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setExportMsg({ type: 'success', text: '数据导出成功' })
    } catch {
      setExportMsg({ type: 'error', text: '网络异常，请稍后重试' })
    } finally {
      setExporting(false)
    }
  }

  if (loading) {
    return (
      <div className="inner-page">
        <div className="inner-container">
          <div className="animate-pulse space-y-6">
            <div className="h-8 bg-zinc-900 rounded-lg w-48" />
            <div className="h-64 bg-zinc-900 rounded-xl" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="inner-page">
      <div className="inner-container">
        {/* 页面标题 */}
        <div className="mb-8">
          <h1 className="inner-header-title">设置</h1>
          <p className="inner-header-sub">管理你的风格卡、隐私和数据</p>
        </div>

        {/* ── 账号信息（昵称） ── */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-6 mb-6">
          <h2 className="text-sm font-medium text-zinc-200 mb-6">账号信息</h2>

          <div className="mb-6">
            <label className="block text-xs text-zinc-500 mb-3">
              昵称（显示在你的个人主页，留空则使用邮箱前缀）
            </label>
            <input
              type="text"
              value={nickname}
              maxLength={20}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="给自己起一个创作者名字"
              className="w-full max-w-xs bg-zinc-800/50 border border-zinc-700/50 rounded-lg px-4 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
            />
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={handleSaveNickname}
              disabled={nicknameSaving}
              className="px-5 py-2.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {nicknameSaving ? '保存中…' : '保存昵称'}
            </button>
            {nicknameMsg && (
              <span className={`text-xs ${nicknameMsg.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                {nicknameMsg.text}
              </span>
            )}
          </div>
        </section>

        {/* ── 创作者访谈（Creator Understanding Engine）── */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-zinc-200">创作者访谈</h2>
            {!declLoading && !isDeclarationEmpty(declaration) && (
              <span className={`text-xs ${isDeclarationComplete(declaration) ? 'text-emerald-400' : 'text-amber-400'}`}>
                {isDeclarationComplete(declaration) ? '已完成' : '未完成'}
              </span>
            )}
          </div>

          <p className="text-xs text-zinc-500 leading-relaxed mb-4">
            回答 10 个问题，让 AI 理解你的创作偏好。访谈结果会影响生成质量，优先级高于 AI 自动推断的风格画像。
          </p>

          {/* 已声明的维度展示 */}
          {!declLoading && !isDeclarationEmpty(declaration) && (
            <div className="mb-4 flex flex-wrap gap-2">
              {extractDeclarationTraits(declaration).map((t, idx) => (
                <span
                  key={idx}
                  className={`text-[11px] px-2 py-0.5 rounded-full border ${
                    t.hard
                      ? 'border-red-500/30 bg-red-500/10 text-red-300'
                      : 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300'
                  }`}
                >
                  {t.dimension}：{t.label}
                </span>
              ))}
            </div>
          )}

          {/* 未访谈提示 */}
          {!declLoading && isDeclarationEmpty(declaration) && (
            <div className="mb-4 text-xs text-amber-400/80 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">
              你还没有完成访谈。完成访谈让 AI 更懂你的创作偏好。
            </div>
          )}

          <button
            type="button"
            onClick={() => setInterviewOpen(true)}
            className="text-xs bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/40 text-indigo-300 px-4 py-2 rounded-lg transition"
          >
            {isDeclarationEmpty(declaration) ? '开始访谈' : '重新访谈 / 修改'}
          </button>

          {/* 访谈弹窗（复用 /generate 同一组件）*/}
          <InterviewDialog
            open={interviewOpen}
            accessToken={accessToken}
            onCompleted={() => {
              setInterviewOpen(false)
              // 重新加载 declaration
              if (accessToken) void loadDeclaration(accessToken)
              // 清除 dismissed 标记，让 generate 页也可以重新触发判断
              try { localStorage.removeItem('interview_dismissed_at') } catch { /* ignore */ }
            }}
            onDismiss={() => {
              setInterviewOpen(false)
              // settings 页不算"跳过"，不写 dismissed 标记
            }}
          />
        </section>

        {/* ── 隐私设置 ── */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-6 mb-6">
          <h2 className="text-sm font-medium text-zinc-200 mb-6">隐私设置</h2>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-zinc-300">发布灵感时默认公开</p>
              <p className="text-xs text-zinc-500 mt-1">
                关闭后，新发布的灵感默认仅自己可见
              </p>
            </div>
            <button
              onClick={handleTogglePublic}
              className={`relative w-12 h-6 rounded-full transition shrink-0 ${
                defaultPublic ? 'bg-indigo-600' : 'bg-zinc-700'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  defaultPublic ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </section>

        {/* ── 数据导出 ── */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-6">
          <h2 className="text-sm font-medium text-zinc-200 mb-6">数据导出</h2>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-zinc-300">导出我的全部数据</p>
              <p className="text-xs text-zinc-500 mt-1">
                包含发布的灵感、素材库、生成历史、风格卡、关注关系
              </p>
            </div>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="px-5 py-2.5 rounded-lg text-sm font-medium bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {exporting ? '导出中…' : '导出 JSON'}
            </button>
          </div>

          {exportMsg && (
            <p className={`text-xs mt-4 ${exportMsg.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
              {exportMsg.text}
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
