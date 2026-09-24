import type { ArchiveSnapshot } from '@/lib/creative/archive'

/** 社区帖子（广场列表 / 详情 / 作者主页共用） */
export interface CommunityPost {
  id: string
  user_id: string
  content: string
  content_type: string
  category: string
  tags: string[] | null
  like_count: number
  comment_count: number
  save_count: number
  is_public?: boolean
  created_at: string
  author_name: string
  /** 0008 迁移新增；未执行迁移时为 undefined → 降级首字母头像 */
  author_avatar_url?: string | null
  current_user_liked: boolean
  current_user_saved: boolean
  image_url: string | null
  post_type?: string | null
  archive?: ArchiveSnapshot | null
  source_project_id?: string | null
}

/** 评论 */
export interface CommunityComment {
  id: string
  post_id: string
  user_id: string
  content: string
  created_at: string
  author_name: string
  author_avatar_url?: string | null
}

/**
 * 互动后的服务端权威状态，用于校正乐观更新。
 * 字段可选：服务端读回失败时会省略该字段，此时前端保留自己的乐观值，
 * 不要当成 0（否则一次抖动就会把点赞数清零）。
 */
export interface PostInteractionState {
  liked?: boolean
  saved?: boolean
  likeCount?: number
  saveCount?: number
  commentCount?: number
}
