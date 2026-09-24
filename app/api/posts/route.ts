import { NextResponse } from 'next/server'
import { CATEGORIES } from '@/lib/constants'
import { rateLimit } from '@/lib/rateLimit'
import {
  authenticateWithToken,
  cleanupFile,
  extractBearerToken,
  generateEmbedding,
  generateImageDescription,
  uploadImageToStorage,
  validateImageFile,
} from '@/lib/storage'
import { parseVector, updateUserStyleVector } from '@/lib/styleVector'
import { fetchPostsBaseCached, invalidatePostsBaseCache } from '@/lib/postsCache'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

// 公共帖子列表缓存已抽到 lib/postsCache.ts：
// 互动/评论/发布/删除等写路径都要 invalidatePostsBaseCache()，
// 否则刷新后会拿到 60 秒前的旧计数（"点赞刷新消失"根因之一）。
export { invalidatePostsBaseCache }

/** 单个帖子的当前用户状态 */
type PostUserState = { liked: boolean; saved: boolean }

/** POST 请求体字段 */
interface PostBody {
  content?: unknown
  category?: unknown
  tags?: unknown
  hasImage?: unknown
}

/** 安全取字符串并截断 */
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/**
 * 解析标签字符串（逗号分隔），返回数组。
 * "电影, 悬疑, 轻松" → ['电影', '悬疑', '轻松']
 */
function parseTags(v: unknown, maxLen: number, maxCount: number): string[] {
  if (typeof v !== 'string') return []
  return v
    .split(/[,，]/)
    .map((t) => t.trim().slice(0, maxLen))
    .filter((t) => t.length > 0)
    .slice(0, maxCount)
}

/** 校验类别的下拉值：不使用 toCategory 的严格校验，允许 '其他' 等新分类 */
function validCategory(v: unknown): string {
  if (typeof v !== 'string') return CATEGORIES[0]
  return (CATEGORIES as readonly string[]).includes(v) ? v : CATEGORIES[0]
}

// ────────────────────────────────────────────────────────────
// GET /api/posts：获取灵感广场帖子列表
// P3-1 优化：
//   - 无风格向量分支：get_posts_base（unstable_cache 60s）+ get_posts_user_state
//     公共数据跨用户共享缓存，用户状态独立批量查
//   - 有风格向量分支：保留原 get_recommended_posts（个性化排序，不可缓存）
// ────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  try {
    // ── 鉴权 ──
    const token = extractBearerToken(req)
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const auth = await authenticateWithToken(token)
    if (!auth.ok) return auth.response
    const { supabase, userId } = auth

    // 从 query string 解析分页参数
    const url = new URL(req.url)
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10), 1), 100)
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10), 0)

    // ── 查询用户风格向量 ──
    const { data: profile, error: profileErr } = await supabase
      .from('style_profiles')
      .select('style_vector')
      .eq('user_id', userId)
      .maybeSingle()

    if (profileErr) {
      console.error('查询风格向量失败:', profileErr)
    }

    const userVector = parseVector(profile?.style_vector)

    // ── 分支：无风格向量 → 走缓存路径 ──
    if (!userVector) {
      // P3-1: 公共数据走 unstable_cache（跨用户共享，TTL 60s）
      const postsBase = await fetchPostsBaseCached(supabase, limit, offset)

      // 批量查用户状态（一次 IN 查询代替 N 个 exists）
      const postIds = postsBase.map((p) => p.id)
      const { data: stateRows } = await supabase.rpc('get_posts_user_state', {
        p_user_id: userId,
        p_post_ids: postIds,
      })
      const stateMap = new Map<string, PostUserState>()
      for (const row of stateRows ?? []) {
        stateMap.set(row.post_id, {
          liked: !!row.liked,
          saved: !!row.saved,
        })
      }

      // 合并公共数据 + 用户状态，保持响应结构与原 RPC 一致
      const posts = postsBase.map((p) => ({
        ...p,
        current_user_liked: stateMap.get(p.id)?.liked ?? false,
        current_user_saved: stateMap.get(p.id)?.saved ?? false,
        similarity: null,
      }))

      return NextResponse.json({
        posts,
        hasStyleVector: false,
        // 前端据此判断"这条是不是我发的"（删除按钮 / 是否可给自己点赞）
        viewerId: userId,
      })
    }

    // ── 分支：有风格向量 → 走原推荐 RPC（个性化排序，不可缓存）──
    // 注：P3-1b 拆分实测无收益反而略慢（多 1 次网络往返），已回滚到原 RPC
    // 真正瓶颈在向量排序 + JOIN auth.users，需 DB 索引优化（见 0004_posts_indexes.sql）
    const rpcParams: Record<string, unknown> = {
      p_limit: limit,
      p_offset: offset,
      p_user_vector: `[${userVector.join(',')}]`,
    }

    const { data, error } = await supabase.rpc('get_recommended_posts', rpcParams)

    if (error) {
      console.error('获取推荐帖子失败:', error)
      // 服务端日志保留细节；数据库报错可能含表名/策略名，不能回显给客户端
      return NextResponse.json({ error: '获取失败' }, { status: 500 })
    }

    return NextResponse.json({
      posts: data ?? [],
      hasStyleVector: true,
      viewerId: userId,
    })
  } catch (error) {
    console.error('posts GET 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

// ────────────────────────────────────────────────────────────
// POST /api/posts：发布灵感（文字或图片）
// 流程：
//   1. 验证用户登录
//   2. 如果有图片：上传到 Storage → 调视觉模型生成描述 → 合并到 content
//   3. 为 content 生成 embedding
//   4. 插入 posts 表
//   5. 失败时清理已上传的图片文件
// ────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  try {
    // ── 1. 鉴权 ──
    const token = extractBearerToken(req)
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const auth = await authenticateWithToken(token)
    if (!auth.ok) return auth.response
    const { supabase, userId } = auth

    // ── 限流：每用户每分钟最多 5 次（涉及视觉模型 + 向量化，成本较高）──
    const rl = rateLimit(`posts:${userId}`, 5, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    // ── 2. 解析表单数据（支持 multipart/form-data，因为可能有图片文件）──
    const formData = await req.formData()
    const body: PostBody = {
      content: formData.get('content'),
      category: formData.get('category'),
      tags: formData.get('tags'),
      hasImage: formData.get('hasImage'),
    }

    // ── 3. 提取并校验字段 ──
    const userContent = str(body.content, 10000)
    const category = validCategory(body.category)
    const tags = parseTags(body.tags, 20, 10)
    const hasImage = body.hasImage === 'true'

    // 文字内容必填（图片场景下视觉描述会合并进来，但用户必须至少输入一些文字）
    if (!userContent && !hasImage) {
      return NextResponse.json({ error: '请输入内容' }, { status: 400 })
    }

    let finalContent = userContent
    let contentType: 'text' | 'image' = 'text'
    let uploadedFileName: string | null = null
    let imageUrl: string | null = null

    // ── 4. 图片上传 + 视觉描述（如果用户上传了图片）──
    if (hasImage) {
      const file = formData.get('file')
      const validation = validateImageFile(file)

      if ('error' in validation) {
        const messages: Record<string, string> = {
          no_file: '请选择图片文件',
          too_large: '图片不能超过 5MB',
          invalid_type: '仅支持 jpg/png/webp/gif 格式图片',
        }
        return NextResponse.json(
          { error: messages[validation.error] ?? '图片校验失败' },
          { status: 400 }
        )
      }

      // 上传到 Storage
      const uploadResult = await uploadImageToStorage(supabase, file as File, userId, validation.ext)
      if (!uploadResult) {
        return NextResponse.json({ error: '图片上传失败' }, { status: 500 })
      }
      uploadedFileName = uploadResult.fileName
      imageUrl = uploadResult.imageUrl

      // 调视觉模型生成图片描述（直接用 base64 传给模型，避免 URL 下载失败）
      const imgFile = file as File
      const imgBuffer = Buffer.from(await imgFile.arrayBuffer())
      const description = await generateImageDescription(imgBuffer, imgFile.type)
      if (!description) {
        await cleanupFile(supabase, uploadedFileName)
        return NextResponse.json({ error: '图片分析失败' }, { status: 500 })
      }

      // 将用户输入 + 图片描述合并为最终内容
      contentType = 'image'
      finalContent = userContent
        ? `${userContent}\n\n[图片描述] ${description}`
        : `[图片描述] ${description}`
    }

    // ── 5. 生成 embedding ──
    if (!finalContent) {
      if (uploadedFileName) await cleanupFile(supabase, uploadedFileName)
      return NextResponse.json({ error: '内容不能为空' }, { status: 400 })
    }

    const embedding = await generateEmbedding(finalContent)
    if (!embedding) {
      if (uploadedFileName) await cleanupFile(supabase, uploadedFileName)
      return NextResponse.json({ error: '内容向量化失败，请稍后重试' }, { status: 500 })
    }

    // ── 6. 插入 posts 表 ──
    const { data, error: insertError } = await supabase
      .from('posts')
      .insert({
        user_id: userId,
        content: finalContent,
        content_type: contentType,
        category,
        tags,
        style_vector: embedding,
        is_public: true,
        image_url: imageUrl,
      })
      .select('id')
      .single()

    if (insertError) {
      console.error('插入 posts 失败:', insertError)
      if (uploadedFileName) await cleanupFile(supabase, uploadedFileName)
      return NextResponse.json({ error: '发布失败' }, { status: 500 })
    }

    // ── 7. 更新用户风格向量（后置操作，失败不阻断发布）──
    // 公式：new = 0.8 * old + 0.2 * post_embedding
    // 使风格向量随用户新发布内容实时微调
    await updateUserStyleVector(supabase, userId, embedding)

    // P3-1: 发布作品后失效公共列表缓存，让其他用户立即看到新帖
    invalidatePostsBaseCache()

    return NextResponse.json({
      success: true,
      postId: data?.id,
      content: finalContent,
      contentType,
    })
  } catch (error) {
    console.error('posts API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
