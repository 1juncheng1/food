'use client'

// 社区 Feed 卡片：作者行 + 标题 + 摘要 + 标签 + 互动条 + 内联评论。
// 整卡点击进入 /post/[id]（阅读 → 讨论 → 看作者）。
//
// 状态一律由父组件持有：点赞/收藏走"乐观更新 + 服务端返回值校正"，
// 卡片本身不发请求，避免多处各自维护和 DB 漂移。

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import AuthorBadge from './author-badge'
import PostActionBar from './post-action-bar'
import CommentSection from './comment-section'
import ArchiveBody from './archive-body'
import { extractTitleAndSummary, getImageDescription } from '@/lib/community/format'
import type { CommunityPost } from '@/lib/community/types'
import type { AuthorCard } from '@/lib/community/authorCard'

interface FeedPostCardProps {
  post: CommunityPost
  token: string | null
  /** 当前用户 ID：判断是否显示删除按钮 */
  viewerId?: string | null
  viewerName?: string
  /** 作者身份卡（0010 起）：没有就退回纯昵称展示 */
  authorCard?: AuthorCard | null
  busyLike?: boolean
  busySave?: boolean
  deleting?: boolean
  onToggleLike: (postId: string) => void
  onToggleSave: (postId: string) => void
  onCommentAdded?: (postId: string) => void
  /** 评论被删除：参数为服务端最新评论数（前端据此回写，不要自己 -1） */
  onCommentDeleted?: (postId: string, commentCount: number) => void
  onDelete?: (postId: string) => void
}

export default function FeedPostCard({
  post,
  token,
  viewerId,
  viewerName,
  authorCard,
  busyLike = false,
  busySave = false,
  deleting = false,
  onToggleLike,
  onToggleSave,
  onCommentAdded,
  onCommentDeleted,
  onDelete,
}: FeedPostCardProps) {
  const router = useRouter()
  const [commentsOpen, setCommentsOpen] = useState(false)

  const isArchive = post.post_type === 'archive' && !!post.archive
  const { title, summary } = extractTitleAndSummary(post.content)
  const heading = isArchive ? post.archive!.title || title : title || '灵感分享'
  const imgDesc = post.content_type === 'image' ? getImageDescription(post.content) : null
  const canDelete = !!viewerId && viewerId === post.user_id && !!onDelete

  // 作者身份（0010 起）：有信息才占位，没信息时卡片外观与旧版一致
  const authorMeta =
    authorCard && (authorCard.postCount > 0 || authorCard.domains.length > 0)
      ? [
          authorCard.postCount > 0 ? `${authorCard.postCount} 篇灵感` : null,
          authorCard.domains.length > 0 ? authorCard.domains.join(' · ') : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null

  return (
    <article
      onClick={() => router.push(`/post/${post.id}`)}
      className="vs-frame cursor-pointer px-6 py-5 transition hover:border-[var(--vs-line-2)]"
    >
      {/* ── 作者行 ── */}
      <div className="flex items-center gap-3 mb-3">
        <AuthorBadge
          userId={post.user_id}
          name={post.author_name || authorCard?.authorName || '创作者'}
          avatarUrl={post.author_avatar_url ?? authorCard?.authorAvatarUrl}
          createdAt={post.created_at}
          meta={authorMeta}
        />
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {isArchive ? (
            <span className="vs-verdict">
               创作档案
            </span>
          ) : (
            <span className="text-xs px-2.5 py-1 rounded-lg bg-[var(--vs-void-2)] text-[var(--vs-ink-3)]">
              {post.category}
            </span>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onDelete!(post.id)
              }}
              disabled={deleting}
              className="vs-link-danger disabled:opacity-40"
              title="删除"
            >
              {deleting ? '删除中…' : '删除'}
            </button>
          )}
        </div>
      </div>

      {/* ── 作者简介：判断"要不要点进这个人的主页"所需的最小信息 ── */}
      {authorCard?.bio && (
        <p
          className="-mt-1.5 mb-3 line-clamp-1 vs-note leading-relaxed"
          title={authorCard.bio}
        >
          {authorCard.bio}
        </p>
      )}

      {/* ── 标题 ── */}
      <h3 className="text-base font-semibold text-[var(--vs-ink)] leading-snug mb-2">
        {heading}
      </h3>

      {/* ── 内容：档案帖走档案块，普通帖走摘要 ── */}
      {isArchive ? (
        <ArchiveBody archive={post.archive!} tags={null} />
      ) : (
        <>
          {summary && (
            <p className="text-[14px] text-[var(--vs-ink-2)] leading-relaxed mb-3 whitespace-pre-wrap">
              {summary}
            </p>
          )}

          {post.image_url && (
            <div className="mb-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={post.image_url}
                alt="帖子图片"
                className="w-full max-h-80 object-cover rounded-xl border border-[var(--vs-line)]"
              />
            </div>
          )}

          {imgDesc && (
            <div className="vs-frame px-4 py-3 mb-3">
              <p className="vs-mark mb-1"> 图片描述</p>
              <p className="text-xs text-[var(--vs-ink-3)] leading-relaxed line-clamp-2">
                {imgDesc.slice(0, 100)}
                {imgDesc.length > 100 ? '…' : ''}
              </p>
            </div>
          )}

          {post.tags && post.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {post.tags.map((tag) => (
                <span
                  key={tag}
                  className="vs-verdict"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {summary.length >= 180 && (
            <span className="vs-link text-xs">查看全文 →</span>
          )}
        </>
      )}

      {/* ── 互动条 ── */}
      <div className="pt-1">
        <PostActionBar
          postId={post.id}
          liked={post.current_user_liked}
          saved={post.current_user_saved}
          likeCount={post.like_count}
          commentCount={post.comment_count}
          saveCount={post.save_count}
          busyLike={busyLike}
          busySave={busySave}
          onToggleLike={() => onToggleLike(post.id)}
          onToggleSave={() => onToggleSave(post.id)}
          onToggleComments={() => setCommentsOpen((v) => !v)}
          commentsOpen={commentsOpen}
        />
      </div>

      {/* ── 内联评论（展开时挂载，卸载即折叠）── */}
      {commentsOpen && (
        <div onClick={(e) => e.stopPropagation()}>
          <CommentSection
            postId={post.id}
            token={token}
            viewerName={viewerName}
            viewerId={viewerId ?? undefined}
            onCommentAdded={() => onCommentAdded?.(post.id)}
            onCommentDeleted={(count) => onCommentDeleted?.(post.id, count)}
          />
        </div>
      )}
    </article>
  )
}
