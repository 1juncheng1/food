import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import { rateLimit } from '@/lib/rateLimit'
import {
  isSafeAvatarUrl,
  updateOwnUserMetadata,
} from '@/lib/authMetadata'
import {
  cleanupFile,
  mediaPathFromUrl,
  uploadAvatarToStorage,
  validateAvatarFile,
} from '@/lib/storage'
import { invalidatePostsBaseCache } from '@/lib/postsCache'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

// ────────────────────────────────────────────────────────────
// PATCH /api/profile/me  —— 改昵称 / 换头像（外链）/ 清头像
// POST  /api/profile/me  —— 上传头像文件（multipart）
//
// 身份只写 auth.users.raw_user_meta_data（GoTrue），不新建 profiles 表：
// 昵称与头像的权威来源必须唯一，否则社区里会同时出现两份不同步的资料。
// ────────────────────────────────────────────────────────────

const NICKNAME_MIN = 1
const NICKNAME_MAX = 24

const NO_STORE = { 'Cache-Control': 'no-store' } as const

/** 取当前用户（复用与 /api/upload-image 一致的「服务端不参与 token 轮换」口径） */
async function currentUser(token: string) {
  const supabase = createServerClient(token)
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) {
    return { ok: false as const, response: authFailureResponse(error), supabase, user: null }
  }
  return { ok: true as const, supabase, userId: data.user.id, user: data.user }
}

export async function PATCH(req: Request) {
  try {
    const raw = req.headers.get('authorization') ?? ''
    const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : ''
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401, headers: NO_STORE })
    }

    const me = await currentUser(token)
    if (!me.ok) return me.response

    const body = (await req.json().catch(() => null)) as {
      displayName?: unknown
      avatarUrl?: unknown
    } | null
    if (!body) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400, headers: NO_STORE })
    }

    const patch: { display_name?: string; avatar_url?: string | null } = {}

    if ('displayName' in body) {
      const name = typeof body.displayName === 'string' ? body.displayName.trim() : ''
      if (name.length < NICKNAME_MIN || name.length > NICKNAME_MAX) {
        return NextResponse.json(
          { error: `昵称长度需在 ${NICKNAME_MIN}-${NICKNAME_MAX} 个字符之间` },
          { status: 400, headers: NO_STORE }
        )
      }
      // 昵称会显示在 HTML 里，<> 虽被 React 转义，但去掉能避免下游（导出/分享）出问题
      const cleaned = name.replace(/[<>]/g, '')
      if (!cleaned) {
        return NextResponse.json({ error: '昵称不能为空' }, { status: 400, headers: NO_STORE })
      }
      patch.display_name = cleaned
    }

    if ('avatarUrl' in body) {
      const v = body.avatarUrl
      if (v === null || v === '') {
        patch.avatar_url = null
      } else if (isSafeAvatarUrl(v)) {
        patch.avatar_url = v.trim()
      } else {
        return NextResponse.json(
          { error: '头像地址无效（仅支持 http/https 链接）' },
          { status: 400, headers: NO_STORE }
        )
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: '没有需要更新的内容' }, { status: 400, headers: NO_STORE })
    }

    const rl = rateLimit(`profile:${me.userId}`, 20, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试' },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    const updated = await updateOwnUserMetadata(token, patch)
    if (!updated.ok) {
      return NextResponse.json(
        { error: updated.error },
        { status: updated.status, headers: NO_STORE }
      )
    }

    // 清除头像时回收旧文件（只删自己目录下的对象，Best effort）
    if (patch.avatar_url === null) {
      const oldUrl = me.user?.user_metadata?.avatar_url
      const oldPath = mediaPathFromUrl(
        typeof oldUrl === 'string' ? oldUrl : null,
        me.userId
      )
      if (oldPath) await cleanupFile(me.supabase, oldPath)
    }

    // 昵称/头像会渲染在 Feed/评论/主页，公共列表缓存里的 author_name 已过期
    invalidatePostsBaseCache()

    return NextResponse.json(
      { displayName: updated.displayName, avatarUrl: updated.avatarUrl },
      { headers: NO_STORE }
    )
  } catch (error) {
    console.error('profile/me PATCH 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: Request) {
  try {
    const raw = req.headers.get('authorization') ?? ''
    const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : ''
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401, headers: NO_STORE })
    }

    const me = await currentUser(token)
    if (!me.ok) return me.response

    const rl = rateLimit(`avatar:${me.userId}`, 5, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '上传过于频繁，请稍后再试' },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    const formData = await req.formData()
    const file = formData.get('file')
    const validation = validateAvatarFile(file)
    if ('error' in validation) {
      const msg =
        validation.error === 'no_file'
          ? '请选择图片文件'
          : validation.error === 'too_large'
            ? '头像图片不能超过 2MB'
            : '仅支持 jpg/png/webp/gif 格式图片'
      return NextResponse.json({ error: msg }, { status: 400, headers: NO_STORE })
    }

    const upload = await uploadAvatarToStorage(
      me.supabase,
      file as File,
      me.userId,
      validation.ext
    )
    if (!upload) {
      return NextResponse.json({ error: '头像上传失败，请稍后重试' }, { status: 500, headers: NO_STORE })
    }

    const updated = await updateOwnUserMetadata(token, { avatar_url: upload.imageUrl })
    if (!updated.ok) {
      // metadata 没写进去，刚传的文件就是孤儿 → 回收
      await cleanupFile(me.supabase, upload.fileName)
      return NextResponse.json(
        { error: updated.error },
        { status: updated.status, headers: NO_STORE }
      )
    }

    // 换掉了旧头像：删旧文件（Best effort，失败只留孤儿文件，不影响结果）
    const oldUrl = formData.get('oldAvatarUrl')
    const oldPath = mediaPathFromUrl(typeof oldUrl === 'string' ? oldUrl : null, me.userId)
    if (oldPath && oldPath !== upload.fileName) {
      await cleanupFile(me.supabase, oldPath)
    }

    invalidatePostsBaseCache()

    return NextResponse.json({ avatarUrl: updated.avatarUrl }, { headers: NO_STORE })
  } catch (error) {
    console.error('profile/me POST 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500, headers: NO_STORE })
  }
}
