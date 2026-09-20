'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { CATEGORIES } from '@/lib/constants'
import { supabase } from '@/lib/supabaseClient'

// ────────────────────────────────────────────────────────────
// 发布灵感页面：用户发布文字或图片灵感到社区
// 数据通过 /api/posts POST 提交
// ────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

export default function PublishPage() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [content, setContent] = useState('')
  const [category, setCategory] = useState<string>(CATEGORIES[0])
  const [tags, setTags] = useState('')
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
      formData.append('category', category)
      formData.append('tags', tags.trim())
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
      setTags('')
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
    <div className="inner-page gen-stage" data-mode="inspiration">
      <div className="inner-container">
        {/* ── 顶部 ── */}
        <div className="inner-header">
          <div>
            <h1 className="inner-header-title">发布灵感</h1>
            <p className="inner-header-sub">把你的创作分享给社区</p>
          </div>
        </div>

        {/* ── 错误提示 ── */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-5 py-4 mb-6">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* ── 成功提示 ── */}
        {success && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-5 py-4 mb-6">
            <p className="text-sm text-emerald-400">发布成功！正在跳转到灵感广场…</p>
          </div>
        )}

        {/* ── 发布表单 ── */}
        <form onSubmit={handleSubmit} className="space-y-8 pt-2">
          {/* 分类选择 */}
          <div>
            <label className="block text-sm font-medium text-zinc-200 mb-4">分类</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500 transition"
            >
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          {/* 内容输入 */}
          <div>
            <label className="block text-sm font-medium text-zinc-200 mb-4">
              内容 <span className="text-zinc-500 text-xs">（必填，图片场景下可不填）</span>
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              placeholder="写下你的灵感…"
              className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500 transition resize-y"
            />
          </div>

          {/* 图片上传 */}
          <div>
            <label className="block text-sm font-medium text-zinc-200 mb-4">
              图片 <span className="text-zinc-500 text-xs">（可选，最多 5MB）</span>
            </label>
            {imagePreview ? (
              <div className="relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imagePreview}
                  alt="预览"
                  className="max-w-xs max-h-48 rounded-xl border border-zinc-700"
                />
                <button
                  type="button"
                  onClick={removeImage}
                  className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition"
                >
                  ×
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full border-2 border-dashed border-zinc-700 rounded-xl px-4 py-8 text-sm text-zinc-500 hover:border-zinc-600 hover:text-zinc-400 transition flex flex-col items-center gap-2"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
                <span>点击上传图片</span>
                <span className="text-xs text-zinc-600">支持 jpg/png/webp/gif</span>
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

          {/* 标签输入 */}
          <div>
            <label className="block text-sm font-medium text-zinc-200 mb-4">
              标签 <span className="text-zinc-500 text-xs">（可选，逗号分隔）</span>
            </label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="如：电影, 悬疑, 轻松"
              className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500 transition"
            />
          </div>

          {/* 发布按钮 */}
          <div className="pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="px-8 py-3 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {submitting ? '发布中…' : '发布灵感'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
