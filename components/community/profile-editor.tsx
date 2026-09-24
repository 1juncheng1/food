'use client'

// 编辑我的社区身份：昵称 + 头像。
// 只写 auth.users.raw_user_meta_data（GoTrue），不新增资料表 ——
// 昵称/头像的权威来源必须唯一，否则 Feed、评论、主页会出现两份不同步的资料。

import { useState } from 'react'
import { AuthorAvatar } from './author-badge'
import { updateMyProfile, uploadMyAvatar } from '@/lib/community/postApi'

interface ProfileEditorProps {
  token: string
  initialName: string
  initialAvatar: string | null
  /** 保存成功：回传服务端最新的昵称/头像，父组件直接替换展示 */
  onSaved: (p: { displayName: string; avatarUrl: string | null }) => void
  onCancel: () => void
}

const NICKNAME_MAX = 24

// 头像展示最大边长 96px（见 AuthorAvatar size="lg"），按 2 倍图取 512 足够。
// 原图直传的问题：手机拍的头像动辄 3-5MB，既超过 2MB 上限被拒，
// 又白占带宽与存储；在浏览器先缩放再上传，用户几乎无感。
const AVATAR_EDGE = 512
const AVATAR_QUALITY = 0.85

/**
 * 用 canvas 把图片缩到 512px 并重新编码。
 * 失败（无 canvas / 解码失败 / 编码失败）一律回退原文件 —— 压缩是优化不是必经步骤。
 */
async function compressAvatar(file: File): Promise<File> {
  if (typeof document === 'undefined') return file
  try {
    const bitmapUrl = URL.createObjectURL(file)
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('decode failed'))
      el.src = bitmapUrl
    })
    const scale = Math.min(1, AVATAR_EDGE / Math.max(img.width, img.height))
    const w = Math.round(img.width * scale)
    const h = Math.round(img.height * scale)

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(img, 0, 0, w, h)

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', AVATAR_QUALITY)
    )
    URL.revokeObjectURL(bitmapUrl)
    // 编码失败或压完反而更大（极小图）→ 用原文件
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' })
  } catch {
    return file
  }
}

export default function ProfileEditor({
  token,
  initialName,
  initialAvatar,
  onSaved,
  onCancel,
}: ProfileEditorProps) {
  const [name, setName] = useState(initialName)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [removeAvatar, setRemoveAvatar] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = name.trim()
  const nameInvalid = trimmed.length < 1 || trimmed.length > NICKNAME_MAX

  function handlePickFile(f: File | null) {
    if (!f) return
    if (!/^image\/(jpeg|png|webp|gif)$/.test(f.type)) {
      setError('仅支持 jpg/png/webp/gif 格式图片')
      return
    }
    // 选图上限放宽到 10MB：保存前会先压缩到 512px，多数手机原图压完远小于 2MB。
    // 真正的 2MB 限制在压缩后校验（与服务端一致）。
    if (f.size > 10 * 1024 * 1024) {
      setError('图片不能超过 10MB')
      return
    }
    setError(null)
    setRemoveAvatar(false)
    setFile(f)
    setPreview(URL.createObjectURL(f))
  }

  async function handleSave() {
    if (saving || nameInvalid) return
    setSaving(true)
    setError(null)
    try {
      // 先传图（拿到 URL），再写资料：两步都成功才算保存成功，
      // 避免"头像换了但 metadata 没写进去"导致前端显示旧图
      let avatarUrl: string | null = removeAvatar ? null : initialAvatar
      let avatarChanged = false

      if (file) {
        // 先本地压缩（512px / jpeg 0.85），再校验 2MB —— 与服务端同一个上限
        const compressed = await compressAvatar(file)
        if (compressed.size > 2 * 1024 * 1024) {
          setError('图片压缩后仍超过 2MB，请换一张')
          return
        }
        const uploaded = await uploadMyAvatar(token, compressed, initialAvatar)
        avatarUrl = uploaded.avatarUrl
        avatarChanged = true
      } else if (removeAvatar && initialAvatar) {
        avatarChanged = true
      }

      const patch: { displayName?: string; avatarUrl?: string | null } = {}
      if (trimmed !== initialName) patch.displayName = trimmed
      if (avatarChanged) patch.avatarUrl = avatarUrl

      if (Object.keys(patch).length === 0) {
        onCancel()
        return
      }

      const saved = await updateMyProfile(token, patch)
      onSaved({
        displayName: saved.displayName || trimmed,
        avatarUrl: saved.avatarUrl ?? avatarUrl,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  const shownAvatar = preview ?? (removeAvatar ? null : initialAvatar)

  return (
    <div className="mt-5 pt-5 border-t border-zinc-800">
      <div className="flex items-start gap-4 flex-wrap">
        <AuthorAvatar name={trimmed || '创作者'} avatarUrl={shownAvatar} size="lg" />

        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">昵称</label>
            <input
              type="text"
              value={name}
              maxLength={NICKNAME_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder="给自己起个好记的名字"
              className="w-full max-w-sm bg-zinc-800/60 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500 transition"
            />
            {nameInvalid && (
              <p className="text-xs text-amber-400 mt-1">
                昵称长度需在 1-{NICKNAME_MAX} 个字符之间
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <label className="cursor-pointer text-xs px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition">
              选择图片
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(e) => handlePickFile(e.target.files?.[0] ?? null)}
              />
            </label>
            {file && (
              <button
                type="button"
                onClick={() => {
                  setFile(null)
                  setPreview(null)
                }}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition"
              >
                取消选择
              </button>
            )}
            {(initialAvatar || preview) && !removeAvatar && (
              <button
                type="button"
                onClick={() => {
                  setFile(null)
                  setPreview(null)
                  setRemoveAvatar(true)
                }}
                className="text-xs text-zinc-500 hover:text-red-400 transition"
              >
                移除头像
              </button>
            )}
            <span className="text-[11px] text-zinc-600">
              支持 jpg/png/webp/gif，≤10MB（自动压缩到 512px）
            </span>
          </div>
        </div>
      </div>

      {error && <p className="text-xs text-red-400 mt-3">{error}</p>}

      <div className="flex items-center gap-2 mt-4">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            void handleSave()
          }}
          disabled={saving || nameInvalid}
          className="px-4 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-4 py-2 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40 transition"
        >
          取消
        </button>
      </div>
    </div>
  )
}
