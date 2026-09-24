import type { SupabaseClient } from '@supabase/supabase-js'
import {
  authenticateToken,
  extractBearerToken as extractBearerFromRequest,
  type AuthResult,
} from '@/lib/apiAuth'

/** 成功分支类型，供可选鉴权路由复用（保持从 storage 一处导入） */
export type { AuthOk } from '@/lib/apiAuth'

// ────────────────────────────────────────────────────────────
// 公共存储 + AI 工具函数：图片上传、视觉描述、文本嵌入
// 被 /api/upload-image 和 /api/posts 复用，避免重复实现
// ────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 5 * 1024 * 1024

/** MIME 类型白名单 + 扩展名映射：防止上传 SVG/HTML 等可执行内容 */
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** 图片上传结果 */
export interface UploadResult {
  imageUrl: string
  fileName: string
}

/** 图片上传校验失败原因 */
export type ValidationError = 'no_file' | 'too_large' | 'invalid_type'

/**
 * 校验图片文件：必须是真实 File 对象、大小合规、类型在白名单内。
 * 返回 { ext } 表示通过，{ error } 表示失败。
 */
export function validateImageFile(file: unknown): { ext: string } | { error: ValidationError } {
  if (!(file instanceof File)) return { error: 'no_file' }
  if (file.size === 0 || file.size > MAX_FILE_SIZE) return { error: 'too_large' }
  const ext = ALLOWED_IMAGE_TYPES[file.type]
  if (!ext) return { error: 'invalid_type' }
  return { ext }
}

/**
 * 上传图片到 Supabase Storage media 桶，返回公开 URL。
 * 调用方需确保 file 已通过 validateImageFile 校验。
 */
export async function uploadImageToStorage(
  supabase: SupabaseClient,
  file: File,
  userId: string,
  ext: string
): Promise<UploadResult | null> {
  const fileName = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const { error: uploadError } = await supabase.storage
    .from('media')
    .upload(fileName, buffer, {
      contentType: file.type,
      upsert: false,
    })

  if (uploadError) {
    console.error('上传错误:', uploadError)
    return null
  }

  const { data: publicUrlData } = supabase.storage
    .from('media')
    .getPublicUrl(fileName)

  const imageUrl = publicUrlData?.publicUrl
  if (!imageUrl) return null

  return { imageUrl, fileName }
}

/**
 * 删除已上传的文件（后续步骤失败时清理孤儿文件）。
 */
export async function cleanupFile(supabase: SupabaseClient, fileName: string): Promise<void> {
  try {
    await supabase.storage.from('media').remove([fileName])
  } catch {
    // 清理失败无需阻断主流程
  }
}

// ────────────────────────────────────────────────────────────
// 头像：复用 media 桶（不再新建桶，省一次迁移 + 一套 RLS 策略）
//
// 约束：storage.objects 的策略是 (storage.foldername(name))[1] = auth.uid()::text，
// 即**路径第一段必须是用户 ID**。头像路径固定为 <userId>/avatar-<ts>.<ext>。
// ────────────────────────────────────────────────────────────

const AVATAR_MAX_SIZE = 2 * 1024 * 1024

/** 头像校验：与帖子图片同白名单，但尺寸上限更小（头像不需要 5MB） */
export function validateAvatarFile(
  file: unknown
): { ext: string } | { error: ValidationError } {
  if (!(file instanceof File)) return { error: 'no_file' }
  if (file.size === 0 || file.size > AVATAR_MAX_SIZE) return { error: 'too_large' }
  const ext = ALLOWED_IMAGE_TYPES[file.type]
  if (!ext) return { error: 'invalid_type' }
  return { ext }
}

/** 上传头像，返回公开 URL */
export async function uploadAvatarToStorage(
  supabase: SupabaseClient,
  file: File,
  userId: string,
  ext: string
): Promise<UploadResult | null> {
  const fileName = `${userId}/avatar-${Date.now()}.${ext}`
  const arrayBuffer = await file.arrayBuffer()
  const { error } = await supabase.storage
    .from('media')
    .upload(fileName, Buffer.from(arrayBuffer), {
      contentType: file.type,
      upsert: false,
    })
  if (error) {
    console.error('头像上传错误:', error)
    return null
  }
  const { data } = supabase.storage.from('media').getPublicUrl(fileName)
  if (!data?.publicUrl) return null
  return { imageUrl: data.publicUrl, fileName }
}

/**
 * 从 media 桶的公开 URL 反解对象路径，用于删除被替换掉的旧头像。
 * 只接受「第一段 = userId」的路径 —— 否则一个伪造的 URL 就能删掉别人的文件。
 */
export function mediaPathFromUrl(
  url: string | null | undefined,
  userId: string
): string | null {
  if (!url) return null
  const marker = '/storage/v1/object/public/media/'
  const idx = url.indexOf(marker)
  if (idx < 0) return null
  const path = decodeURIComponent(url.slice(idx + marker.length).split('?')[0] ?? '')
  if (!path) return null
  const first = path.split('/')[0]
  if (first !== userId) return null
  return path
}

/**
 * 调用 SiliconFlow 视觉模型生成图片描述。
 * 使用 Qwen/Qwen3-VL-8B-Instruct 模型，100 字以内中文描述。
 * 直接传入 base64 编码的图片数据，避免 URL 下载失败。
 */
export async function generateImageDescription(
  imageBuffer: Buffer,
  mimeType: string
): Promise<string | null> {
  // 超时保护：视觉模型挂起时 abort，避免 POST /api/posts 无限等待
  // 15s 足够 VL 模型处理图片（用户触发动作，非首屏路径）
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const base64 = imageBuffer.toString('base64')
    const dataUrl = `data:${mimeType};base64,${base64}`

    const res = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'Qwen/Qwen3-VL-8B-Instruct',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUrl } },
              {
                type: 'text',
                text: '请用中文详细描述这张图片的内容，包括主体、场景、氛围、以及可能适合电影解说的元素，100字以内。',
              },
            ],
          },
        ],
        max_tokens: 200,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      console.error('视觉模型错误:', await res.text())
      return null
    }
    const data = await res.json()
    const description = data?.choices?.[0]?.message?.content
    return typeof description === 'string' && description.trim().length > 0
      ? description.trim()
      : null
  } catch (e) {
    console.error('视觉模型调用异常:', e)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * 调用 SiliconFlow bge-m3 模型生成文本的嵌入向量（1024 维）。
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  // 超时保护：embedding 调用挂起时 abort，避免发布作品/更新风格向量无限等待
  // 10s 足够 bge-m3 向量化文本（用户触发动作，非首屏路径）
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch('https://api.siliconflow.cn/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'BAAI/bge-m3',
        input: text.slice(0, 8000), // 截断防止超出嵌入模型上限
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.error('嵌入向量生成失败:', await res.text())
      return null
    }
    const data = await res.json()
    const embedding = data?.data?.[0]?.embedding
    return Array.isArray(embedding) ? embedding : null
  } catch (e) {
    console.error('嵌入向量生成异常:', e)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * 从 Bearer token 创建带用户上下文的 Supabase 客户端并验证身份。
 *
 * 返回 AuthResult 而非 null：调用方必须这样用
 *   const auth = await authenticateWithToken(token)
 *   if (!auth.ok) return auth.response   // 401=未登录/过期；503=网络故障（不得踢用户）
 * 早期版本一律返回 null，调用方统一兜 401「登录已过期」，于是 Supabase 网络不通时
 * 已登录用户被整站踢到 /login，而 /login 又因同一条网络打不通——死结。
 */
export async function authenticateWithToken(
  token: string,
  noTokenMessage?: string
): Promise<AuthResult> {
  return authenticateToken(token, noTokenMessage)
}

/** 从 Request 的 Authorization 头提取 Bearer token（转发自统一鉴权层） */
export function extractBearerToken(req: Request): string {
  return extractBearerFromRequest(req)
}
