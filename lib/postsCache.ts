import type { SupabaseClient } from '@supabase/supabase-js'

// ────────────────────────────────────────────────────────────
// 灵感广场公共帖子列表缓存（Map + TTL）
//
// 为什么不用 unstable_cache：它不能接收 Supabase 客户端对象作为参数，
// 会触发循环引用序列化错误。模式参考 lib/ci/globalTrending.ts。
//
// 关键约束：缓存的是「公共字段」（含 like_count / comment_count）。
// 任何写操作（点赞/收藏/评论/发布/删除）都必须调用 invalidatePostsBaseCache()，
// 否则用户刷新后会看到 60 秒前的旧计数 —— 这就是"点赞刷新消失"的根因之一。
// ────────────────────────────────────────────────────────────

export type PostBase = {
  id: string
  user_id: string
  content: string
  content_type: string
  category: string
  tags: string[] | null
  like_count: number
  comment_count: number
  save_count: number
  is_public: boolean
  created_at: string
  author_name: string
  /** 0008 迁移新增：未执行迁移时为 undefined，前端降级首字母头像 */
  author_avatar_url?: string | null
  image_url: string | null
  post_type: string | null
  archive: unknown
  source_project_id: string | null
}

type CacheEntry = {
  value: PostBase[]
  expiresAt: number
}

const postsBaseCache = new Map<string, CacheEntry>()
const POSTS_BASE_TTL = 60 * 1000

/** 写操作后调用：清空公共列表缓存，让下一次请求拿到最新计数 */
export function invalidatePostsBaseCache() {
  postsBaseCache.clear()
}

async function fetchPostsBaseRaw(
  supabase: SupabaseClient,
  limit: number,
  offset: number
): Promise<PostBase[]> {
  const { data, error } = await supabase.rpc('get_posts_base', {
    p_limit: limit,
    p_offset: offset,
  })
  if (error) {
    console.error('get_posts_base 失败:', error)
    return []
  }
  return (data ?? []) as PostBase[]
}

export async function fetchPostsBaseCached(
  supabase: SupabaseClient,
  limit: number,
  offset: number
): Promise<PostBase[]> {
  const key = `pb:${limit}:${offset}`
  const now = Date.now()
  const cached = postsBaseCache.get(key)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }
  const value = await fetchPostsBaseRaw(supabase, limit, offset)
  if (value.length > 0) {
    postsBaseCache.set(key, { value, expiresAt: now + POSTS_BASE_TTL })
  }
  return value
}
