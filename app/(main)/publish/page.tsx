'use client'

'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import {
  AiStatus,
  ErrorState,
  PageHeader,
  PageShell,
  SurfaceCard,
} from '@/components/vision'

// ────────────────────────────────────────────────────────────
// 发布灵感页面：用户发布文字或图片灵感到社区
// 数据通过 /api/posts POST 提交
// ────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

export default function PublishPage() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [content, setContent] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  /** 选择图片：校验大小和类型，生成预览 */
  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)

    if (file.size > MAX_FILE_SIZE) {
      setError('图片不能超过 5MB')
      return
    }
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      setError('仅支持 jpg/png/webp/gif 格式图片')
      return
    }

    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
  }

  /** 移除已选图片 */
  function removeImage() {
    setImageFile(null)
    if (imagePreview) {
      URL.revokeObjectURL(imagePreview)
      setImagePreview(null)
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  /** 提交发布：构造 FormData，POST 到 /api/posts */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSuccess(false)

    // 校验：文字和图片至少有一个
    if (!content.trim() && !imageFile) {
      setError('请输入内容或上传图片')
      return
    }

    setSubmitting(true)
    try {
      // 获取 session 中的 access_token
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.replace('/login')
        return
      }

      // 构造 FormData（支持图片文件上传）
      const formData = new FormData()
      formData.append('content', content.trim())
      if (imageFile) {
        formData.append('file', imageFile)
        formData.append('hasImage', 'true')
      }

      const res = await fetch('/api/posts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data?.error ?? `发布失败（${res.status}）`)
        return
      }

      // 发布成功：清空表单，提示成功
      setSuccess(true)
      setContent('')
      removeImage()
      // 2 秒后跳转到灵感广场
      setTimeout(() => router.push('/explore'), 2000)
    } catch {
      setError('网络异常，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="inner-page " data-mode="inspiration">
      <PageShell width="narrow">
        {/* 定位：把还没成型的想法交给社区，也让 AI 更懂你在关注什么 */}
        <PageHeader
          eyebrow="创作者社区"
          title="发布灵感"
          description="把你正在琢磨的一句话或一篇作品交给社区。别人会看到，AI 也会据此更新对你关注点的理解。"
          ai={<AiStatus task="publish" active={submitting} variant="bar" />}
        />

        {/* ── 错误提示 ── */}
        {error && <ErrorState className="mb-6" message={error} />}

        {/* ── 成功提示 ── */}
        {success && (
          <SurfaceCard className="mb-6 border-[var(--vs-line)] bg-[var(--vs-void-1)]">
            <p className="text-[14px] text-[var(--vs-ink)]">
              发布成功！正在跳转到灵感广场…
            </p>
          </SurfaceCard>
        )}

        {/* ── 发布表单 ── */}
        <form onSubmit={handleSubmit} className="space-y-8 pt-2">
          {/* 内容输入 */}
          <div>
            <label className="vs-h3 mb-4 block">
              内容 <span className="vs-note">（必填，图片场景下可不填）</span>
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              placeholder="写下你的灵感…"
              className="vs-input vs-input-field w-full resize-y"
            />
          </div>

          {/* 图片上传 */}
          <div>
            <label className="vs-h3 mb-4 block">
              图片 <span className="vs-note">（可选，最多 5MB）</span>
            </label>
            {imagePreview ? (
              <div className="relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imagePreview}
                  alt="预览"
                  className="max-w-xs max-h-48 rounded-xl border border-[var(--vs-line-2)]"
                />
                <button
                  type="button"
                  onClick={removeImage}
                  className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 text-[var(--vs-ink)] flex items-center justify-center hover:bg-black/80 transition"
                >
                  ×
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full border-2 border-dashed border-[var(--vs-line-2)] rounded-xl px-4 py-8 vs-note hover:border-[var(--vs-line-2)] hover:text-[var(--vs-ink-3)] transition flex flex-col items-center gap-2"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
                <span>点击上传图片</span>
                <span className="vs-note">支持 jpg/png/webp/gif</span>
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={handleImageChange}
              className="hidden"
            />
          </div>

          {/* 发布按钮 */}
          <div className="pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="vs-btn vs-btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? '发布中…' : '发布灵感'}
            </button>
          </div>
        </form>
      </PageShell>
    </div>
  )
}
