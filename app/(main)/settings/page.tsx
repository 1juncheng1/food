'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { PageHeader, PageShell } from '@/components/vision'
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

  // 注销账号
  const router = useRouter()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  // 密码是唯一的确认凭证：服务端会用它重新校验身份后才允许注销。
  // 刻意不预填、不允许浏览器自动填充——注销必须是用户亲手输入密码的动作。
  const [deletePassword, setDeletePassword] = useState('')

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

  /** 永久注销账号 */
  async function handleDeleteAccount() {
    if (deleting) return
    // 密码是唯一的确认凭证，空密码不发车
    if (!deletePassword) {
      setDeleteError('请输入密码')
      return
    }
    setDeleteError('')
    setDeleting(true)
    try {
      const res = await fetch('/api/delete-account', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password: deletePassword }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setDeleteError(err?.error ?? '注销失败，请稍后重试')
        return
      }
      // 清除本地状态，跳转到首页
      await supabase.auth.signOut()
      router.push('/')
    } catch {
      setDeleteError('网络异常，请稍后重试')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="inner-page " data-mode="inspiration">
        <div className="inner-container">
          <div className="animate-pulse space-y-6">
            <div className="h-8 bg-[var(--vs-void-1)] rounded-lg w-48" />
            <div className="h-64 bg-[var(--vs-void-1)] rounded-xl" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <PageShell width="narrow">
      {/* 定位：设置不是管理后台，而是「AI 从哪里认识你」 */}
      <PageHeader
        eyebrow="AI 认识你的入口"
        title="设置"
        description="这里的每一处都影响 AI 怎样理解你。尤其是创作者访谈——它直接决定 AI 判断你意图时的依据。"
      />

        {/* ── 账号信息（昵称） ── */}
        <section className="mb-6 rounded-2xl border border-white/[0.08] bg-[var(--vs-void-1)] px-6 py-6">
          <h2 className="vs-h3 mb-6">账号信息</h2>

          <div className="mb-6">
            <label className="block text-xs text-[var(--vs-ink-4)] mb-3">
              昵称（显示在你的个人主页，留空则使用邮箱前缀）
            </label>
            <input
              type="text"
              value={nickname}
              maxLength={20}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="给自己起一个创作者名字"
              className="vs-input vs-input-field w-full max-w-xs"
            />
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={handleSaveNickname}
              disabled={nicknameSaving}
              className="vs-btn vs-btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {nicknameSaving ? '保存中…' : '保存昵称'}
            </button>
            {nicknameMsg && (
              <span className={`text-xs ${nicknameMsg.type === 'success' ? 'text-[var(--vs-ink)]' : 'vs-error-text'}`}>
                {nicknameMsg.text}
              </span>
            )}
          </div>
        </section>

        {/* ── 创作者访谈（Creator Understanding Engine）── */}
        <section className="mb-6 rounded-2xl border border-white/[0.08] bg-[var(--vs-void-1)] px-6 py-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[14px] font-medium text-[var(--vs-ink)]">创作者访谈</h2>
            {!declLoading && !isDeclarationEmpty(declaration) && (
              <span className={`text-xs ${isDeclarationComplete(declaration) ? 'text-[var(--vs-ink)]' : 'vs-note-warn'}`}>
                {isDeclarationComplete(declaration) ? '已完成' : '未完成'}
              </span>
            )}
          </div>

          <p className="text-xs text-[var(--vs-ink-4)] leading-relaxed mb-4">
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
                      ? 'vs-verdict vs-note-warn'
                      : 'vs-verdict'
                  }`}
                >
                  {t.dimension}：{t.label}
                </span>
              ))}
            </div>
          )}

          {/* 未访谈提示 */}
          {!declLoading && isDeclarationEmpty(declaration) && (
            <div className="vs-note vs-note-warn vs-warn mb-4">
              你还没有完成访谈。完成访谈让 AI 更懂你的创作偏好。
            </div>
          )}

          <button
            type="button"
            onClick={() => setInterviewOpen(true)}
            className="vs-btn vs-btn-ghost vs-btn-sm"
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
        <section className="mb-6 rounded-2xl border border-white/[0.08] bg-[var(--vs-void-1)] px-6 py-6">
          <h2 className="vs-h3 mb-6">隐私设置</h2>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-[14px] text-[var(--vs-ink-2)]">发布灵感时默认公开</p>
              <p className="vs-note mt-1">
                关闭后，新发布的灵感默认仅自己可见
              </p>
            </div>
            <button
              onClick={handleTogglePublic}
              className={`relative w-12 h-6 rounded-full transition shrink-0 ${
                defaultPublic ? 'bg-[var(--vs-beam)]' : 'bg-[var(--vs-line-2)]'
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
        <section className="rounded-2xl border border-white/[0.08] bg-[var(--vs-void-1)] px-6 py-6">
          <h2 className="vs-h3 mb-6">数据导出</h2>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-[14px] text-[var(--vs-ink-2)]">导出我的全部数据</p>
              <p className="vs-note mt-1">
                包含发布的灵感、素材库、生成历史、风格卡、关注关系
              </p>
            </div>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="vs-btn vs-btn-ghost shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {exporting ? '导出中…' : '导出 JSON'}
            </button>
          </div>

          {exportMsg && (
            <p className={`text-xs mt-4 ${exportMsg.type === 'success' ? 'text-[var(--vs-ink)]' : 'vs-error-text'}`}>
              {exportMsg.text}
            </p>
          )}
        </section>

        {/* ── 危险区域：注销账号 ── */}
        <section className="vs-danger-zone px-6 py-6 mt-8">
          <h2 className="vs-h3 vs-error-text mb-6">危险区域</h2>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-[14px] text-[var(--vs-ink-2)]">注销账号</p>
              <p className="vs-note mt-1">
                永久删除你的账号和所有数据，包括灵感、素材库、生成历史、关注关系。此操作不可撤销。
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteOpen(true)
                // 每次打开都是空框：绝不带着上一次的输入进对话框
                setDeletePassword('')
                setDeleteError('')
              }}
              className="vs-btn vs-btn-ghost vs-error-text shrink-0"
            >
              注销账号
            </Button>
          </div>

          <Dialog
            open={deleteOpen}
            onOpenChange={(next) => {
              setDeleteOpen(next)
              // 关闭时立刻清空：不把密码留在组件状态里
              if (!next) {
                setDeletePassword('')
                setDeleteError('')
              }
            }}
          >
            <DialogContent showCloseButton={!deleting}>
              <DialogHeader>
                <DialogTitle className="vs-error-text">确认注销账号</DialogTitle>
                <DialogDescription>
                  此操作将永久删除你的账号和所有数据，包括灵感、素材库、生成历史、风格卡、关注关系。操作不可撤销，数据无法恢复。
                </DialogDescription>
              </DialogHeader>

              <div className="py-2">
                <p className="text-xs text-[var(--vs-ink-3)] mb-2">
                  请输入当前账号密码以确认（服务端会二次校验后才允许注销）：
                </p>
                {/* autoComplete="new-password"：阻止浏览器自动填充已保存的密码。
                    自动填充等于"不用真的知道密码就能注销"，与二次校验的本意相悖。 */}
                <input
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  disabled={deleting}
                  placeholder="登录密码"
                  autoComplete="new-password"
                  name="delete-account-confirm-password"
                  className="vs-input vs-input-field w-full"
                />
              </div>

              {deleteError && (
                <p className="vs-error">{deleteError}</p>
              )}

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setDeleteOpen(false)}
                  disabled={deleting}
                >
                  取消
                </Button>
                <Button
                  onClick={handleDeleteAccount}
                  disabled={deleting || deletePassword.length === 0}
                  className="vs-btn vs-btn-danger disabled:opacity-40"
                >
                  {deleting ? '注销中…' : '永久注销'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </section>
    </PageShell>
  )
}
