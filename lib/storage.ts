import { createClient, type SupabaseClient } from '@supabase/supabase-js'

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

/**
 * 调用 SiliconFlow 视觉模型生成图片描述。
 * 使用 Qwen/Qwen3-VL-8B-Instruct 模型，100 字以内中文描述。
 * 直接传入 base64 编码的图片数据，避免 URL 下载失败。
 */
export async function generateImageDescription(
  imageBuffer: Buffer,
  mimeType: string
): Promise<string | null> {
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
  }
}

/**
 * 调用 SiliconFlow bge-m3 模型生成文本的嵌入向量（1024 维）。
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
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
  }
}

/**
 * 从 Bearer token 创建带用户上下文的 Supabase 客户端并验证身份。
 * 复用 supabaseServer 的模式，但返回 supabase client + userId。
 * 返回 null 表示未登录或 token 无效。
 */
export async function authenticateWithToken(token: string): Promise<{ supabase: SupabaseClient; userId: string } | null> {
  if (!token) return null

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return null

  return { supabase, userId: user.id }
}

/** 从 Request 的 Authorization 头提取 Bearer token */
export function extractBearerToken(req: Request): string {
  const authHeader = req.headers.get('authorization') ?? ''
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
}
