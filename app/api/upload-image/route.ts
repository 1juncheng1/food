import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import { toCategory } from '@/lib/constants'
import { rateLimit } from '@/lib/rateLimit'

// Vercel Hobby 套餐单次执行上限为 60 秒，超限会导致部署失败
export const maxDuration = 60

const MAX_FILE_SIZE = 5 * 1024 * 1024

// MIME 类型白名单：防止上传 SVG/HTML 等可执行内容造成存储型 XSS
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.split(' ')[1]
    if (!token) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    // 走 createServerClient：服务端绝不参与 token 轮换，否则会作废浏览器端的
    // refresh_token，把用户踢成 "Invalid Refresh Token"（详见 lib/apiAuth.ts 说明）
    const supabase = createServerClient(token)

    // 验证用户
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser()
    if (userError || !user) {
      return authFailureResponse(userError)
    }

    // 简单限流：每用户每分钟最多 5 次（涉及 OCR + 向量化，成本较高）
    const rl = rateLimit(`upload:${user.id}`, 5, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    // 解析表单数据
    const formData = await req.formData()
    const file = formData.get('file')
    const category = toCategory(formData.get('category'))

    // 校验文件：必须是真实 File 对象、大小合规、类型在白名单内
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '请选择图片文件' }, { status: 400 })
    }
    if (file.size === 0 || file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: '图片不能超过 5MB' }, { status: 400 })
    }
    // accept="image/*" 只是前端提示，可被绕过，这里必须再校验一次
    const fileExt = ALLOWED_IMAGE_TYPES[file.type]
    if (!fileExt) {
      return NextResponse.json({ error: '仅支持 jpg/png/webp/gif 格式图片' }, { status: 400 })
    }

    // 生成唯一文件名（扩展名由 MIME 类型决定，不信任用户上传的原始文件名）
    const fileName = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${fileExt}`

    // 上传到 Supabase Storage
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
      return NextResponse.json({ error: '图片上传失败' }, { status: 500 })
    }

    // 上传成功后，若后续任一步骤失败则清理文件，避免产生孤儿文件
    const cleanupUploadedFile = async () => {
      try {
        await supabase.storage.from('media').remove([fileName])
      } catch {
        // 清理失败无需阻断主流程
      }
    }

    // 获取公开 URL
    const { data: publicUrlData } = supabase.storage
      .from('media')
      .getPublicUrl(fileName)
    const imageUrl = publicUrlData?.publicUrl
    if (!imageUrl) {
      await cleanupUploadedFile()
      return NextResponse.json({ error: '图片上传失败' }, { status: 500 })
    }

    // 调用 SiliconFlow 视觉模型生成描述
    const visionRes = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}`,
        'Content-Type': 'application/json',
      },
      // 外部视觉模型必须设超时上限：挂起会占满 serverless 并发并留下孤儿文件
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: 'deepseek-ai/DeepSeek-OCR',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: imageUrl },
              },
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

    if (!visionRes.ok) {
      const errorText = await visionRes.text()
      console.error('视觉模型错误:', errorText)
      await cleanupUploadedFile()
      return NextResponse.json({ error: '图片分析失败' }, { status: 500 })
    }

    const visionData = await visionRes.json()
    const description = visionData?.choices?.[0]?.message?.content
    if (typeof description !== 'string' || description.trim().length === 0) {
      await cleanupUploadedFile()
      return NextResponse.json({ error: '图片分析失败' }, { status: 500 })
    }

    // 向量化描述文本
    const embeddingRes = await fetch('https://api.siliconflow.cn/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}`,
        'Content-Type': 'application/json',
      },
      // 短输出接口，超时可以更激进
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model: 'BAAI/bge-m3',
        input: description,
      }),
    })

    if (!embeddingRes.ok) {
      const errorText = await embeddingRes.text()
      console.error('Embedding 错误:', errorText)
      await cleanupUploadedFile()
      return NextResponse.json({ error: '向量化失败' }, { status: 500 })
    }

    const embeddingData = await embeddingRes.json()
    const embedding = embeddingData?.data?.[0]?.embedding
    if (!Array.isArray(embedding)) {
      await cleanupUploadedFile()
      return NextResponse.json({ error: '向量化失败' }, { status: 500 })
    }

    // 插入数据库（包含用户选择的分类）
    const { error: insertError } = await supabase.from('scripts').insert({
      user_id: user.id,
      content: description,
      type: 'image',
      category,
      file_url: imageUrl,
      embedding,
    })

    if (insertError) {
      console.error('插入错误:', insertError)
      await cleanupUploadedFile()
      return NextResponse.json({ error: '保存失败' }, { status: 500 })
    }

    return NextResponse.json({ success: true, description, imageUrl })
  } catch (error) {
    console.error('API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
