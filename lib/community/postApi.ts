import type { CommunityComment, PostInteractionState } from './types'

// 灵感广场互动 API 封装：广场 / 详情页 / 作者主页共用同一份请求口径，
// 避免三处各写一份 fetch、各错一次。

const TIMEOUT_MS = 10_000

async function request<T>(
  url: string,
  token: string,
  init: RequestInit = {}
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    })
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null
    if (!res.ok) {
      throw new Error(data?.error ?? `请求失败（${res.status}）`)
    }
    return data as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 点赞 / 收藏 toggle。
 * 返回服务端的权威状态（liked/saved + 三个计数），调用方必须用返回值回写本地，
 * 否则乐观更新误差会累积 —— 这是"点赞刷新就消失"的根因。
 */
export async function toggleInteraction(
  token: string,
  postId: string,
  type: 'like' | 'save'
): Promise<PostInteractionState> {
  const data = await request<PostInteractionState>(
    `/api/posts/${postId}/interactions`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interactionType: type }),
    }
  )

  // 字段缺失 = 服务端没读回（读失败），保持 undefined 让调用方保留本地值
  return {
    liked: data.liked,
    saved: data.saved,
    likeCount: data.likeCount,
    saveCount: data.saveCount,
    commentCount: data.commentCount,
  }
}

/** 拉取评论列表 */
export async function fetchComments(
  token: string,
  postId: string
): Promise<CommunityComment[]> {
  const data = await request<{ comments?: CommunityComment[] }>(
    `/api/posts/${postId}/comments`,
    token
  )
  return data.comments ?? []
}

/** 发表评论，返回带作者名的完整评论（服务端已回填 author_name） */
export async function submitComment(
  token: string,
  postId: string,
  content: string
): Promise<CommunityComment> {
  const data = await request<{ comment?: CommunityComment }>(
    `/api/posts/${postId}/comments`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }
  )
  if (!data.comment) throw new Error('评论返回为空')
  return data.comment
}

/**
 * 删除自己的评论，返回服务端最新评论数（前端不要自己 -1）。
 * 服务端只允许删自己的：403 时把服务端文案抛给上层展示。
 */
export async function deleteComment(
  token: string,
  postId: string,
  commentId: string
): Promise<number> {
  const data = await request<{ commentCount?: number }>(
    `/api/posts/${postId}/comments?commentId=${encodeURIComponent(commentId)}`,
    token,
    { method: 'DELETE' }
  )
  return data.commentCount ?? 0
}

// ────────────────────────────────────────────────────────────
// 我的资料（昵称 + 头像）：写的是 auth.users.raw_user_meta_data
// ────────────────────────────────────────────────────────────

export interface MyProfile {
  displayName: string
  avatarUrl: string | null
}

/** 改昵称 / 换头像（外链）/ 清头像（avatarUrl 传 null） */
export async function updateMyProfile(
  token: string,
  patch: { displayName?: string; avatarUrl?: string | null }
): Promise<MyProfile> {
  const data = await request<Partial<MyProfile>>('/api/profile/me', token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return { displayName: data.displayName ?? '', avatarUrl: data.avatarUrl ?? null }
}

/** 上传头像文件（≤2MB，jpg/png/webp/gif） */
export async function uploadMyAvatar(
  token: string,
  file: File,
  oldAvatarUrl?: string | null
): Promise<MyProfile> {
  const form = new FormData()
  form.append('file', file)
  if (oldAvatarUrl) form.append('oldAvatarUrl', oldAvatarUrl)

  // 不走 request()：FormData 不能带 Content-Type（浏览器需自己生成 boundary）
  const res = await fetch('/api/profile/me', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const data = (await res.json().catch(() => null)) as
    | ({ avatarUrl?: string | null } & { error?: string })
    | null
  if (!res.ok) throw new Error(data?.error ?? `上传失败（${res.status}）`)
  return { displayName: '', avatarUrl: data?.avatarUrl ?? null }
}
