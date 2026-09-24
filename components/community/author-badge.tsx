'use client'

// 作者身份行：头像 + 昵称 + 时间，点击进作者主页。
// 昵称统一由后端 user_display_name 提供（昵称 > 邮箱前缀 > "创作者"），
// 头像不存在时降级为昵称首字母 —— 全站唯一实现，三处页面共用。
//
// 0010 起可以带 meta（"12 篇灵感 · 电影解说"）：没有就整行让位，
// 不留空占位 —— 迁移未执行 / 作者没简介时，卡片外观与旧版完全一致。

import Link from 'next/link'
import { initialOf, timeAgo } from '@/lib/community/format'

interface AuthorBadgeProps {
  userId: string
  name: string
  avatarUrl?: string | null
  createdAt?: string
  size?: 'sm' | 'md' | 'lg'
  /** 是否可点击进主页（详情页作者卡可关闭） */
  link?: boolean
  /** 时间是否显示为绝对时间（详情页用） */
  absoluteTime?: string | null
  /** 昵称下的补充信息（作品数 / 常用领域）。传入才占位，未传不占高度 */
  meta?: string | null
  trailing?: React.ReactNode
}

const SIZE_CLASS: Record<'sm' | 'md' | 'lg', { box: string; name: string; text: string }> = {
  sm: { box: 'w-6 h-6 text-[10px]', name: 'text-xs', text: 'text-[10px]' },
  md: { box: 'w-8 h-8 text-sm', name: 'text-sm', text: 'text-xs' },
  lg: { box: 'w-16 h-16 text-2xl', name: 'text-xl', text: 'text-xs' },
}

export function AuthorAvatar({
  name,
  avatarUrl,
  size = 'md',
}: {
  name: string
  avatarUrl?: string | null
  size?: 'sm' | 'md' | 'lg'
}) {
  const cls = SIZE_CLASS[size].box
  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt={name}
        className={`${cls} rounded-full object-cover shrink-0 border border-zinc-700`}
      />
    )
  }
  return (
    <div
      className={`${cls} rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center font-medium shrink-0`}
    >
      {initialOf(name)}
    </div>
  )
}

export default function AuthorBadge({
  userId,
  name,
  avatarUrl,
  createdAt,
  size = 'md',
  link = true,
  absoluteTime,
  meta,
  trailing,
}: AuthorBadgeProps) {
  const s = SIZE_CLASS[size]
  const displayName = name || '创作者'
  const timeText = absoluteTime ?? (createdAt ? timeAgo(createdAt) : null)
  const metaText = typeof meta === 'string' && meta.trim() ? meta.trim() : null

  const inner = (
    <>
      <AuthorAvatar name={displayName} avatarUrl={avatarUrl} size={size} />
      <div className="min-w-0 flex-1">
        <span className={`${s.name} text-zinc-300 font-medium block truncate`}>
          {displayName}
        </span>
        {timeText && (
          <span className={`${s.text} text-zinc-600`}>{timeText}</span>
        )}
        {metaText && (
          <span className={`${s.text} block truncate text-zinc-500`}>
            {metaText}
          </span>
        )}
      </div>
    </>
  )

  const shellClass = 'flex items-center gap-3 min-w-0'

  return (
    <div className={`${shellClass} ${size === 'lg' ? 'gap-4' : ''}`}>
      {link ? (
        <Link
          href={`/profile/${userId}`}
          className="flex items-center gap-3 min-w-0 group"
          title={`查看 ${displayName} 的主页`}
        >
          <span className="flex items-center gap-3 min-w-0 group-hover:text-indigo-300 transition">
            {inner}
          </span>
        </Link>
      ) : (
        <div className="flex items-center gap-3 min-w-0">{inner}</div>
      )}
      {trailing}
    </div>
  )
}
