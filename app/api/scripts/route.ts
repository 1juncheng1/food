import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { toCategory } from '@/lib/constants'
import { rateLimit } from '@/lib/rateLimit'
import { updateUserStyleVector } from '@/lib/styleVector'

// 防止 Vercel 函数超时，设置最大执行时间为 60 秒
export const maxDuration = 60

// 限制内容长度，避免超出 Embedding 模型上限或被恶意刷接口
const MAX_CONTENT_LENGTH = 10000

export async function POST(req: Request) {
  try {
    // 从请求头获取 access token
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.split(' ')[1]

    if (!token) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    // 用 token 创建 Supabase 客户端（这样 RLS 会生效，确保用户只能写自己的数据）
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    })

    // 获取当前用户
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser()

    if (userError || !user) {
      return NextResponse.json({ error: '用户验证失败' }, { status: 401 })
    }

    // 简单限流：每用户每分钟最多 10 次，防止恶意刷接口
    const rl = rateLimit(`scripts:${user.id}`, 10, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    // 解析请求体
    const body = await req.json()
    const { content } = body
    const category = toCategory(body.category)

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return NextResponse.json({ error: '内容不能为空' }, { status: 400 })
    }

    if (content.length > MAX_CONTENT_LENGTH) {
      return NextResponse.json(
        { error: `内容过长，最多 ${MAX_CONTENT_LENGTH} 字` },
        { status: 400 }
      )
    }

    // 调用 SiliconFlow Embedding API 把文本转成向量
    const embeddingResponse = await fetch('https://api.siliconflow.cn/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'BAAI/bge-m3',
        input: content,
      }),
    })

    if (!embeddingResponse.ok) {
      const errorText = await embeddingResponse.text()
      console.error('Embedding API 错误:', errorText)
      return NextResponse.json({ error: '向量化失败，请稍后重试' }, { status: 500 })
    }

    const embeddingData = await embeddingResponse.json()
    const embedding = embeddingData?.data?.[0]?.embedding // 数组，长度 1024

    if (!Array.isArray(embedding)) {
      return NextResponse.json({ error: '向量格式错误' }, { status: 500 })
    }

    // 插入数据库，user_id 使用当前用户 ID，category 为前端选择的分类
    const { error: insertError } = await supabase.from('scripts').insert({
      user_id: user.id,
      content: content.trim(),
      type: 'text',
      category,
      embedding,
    })

    if (insertError) {
      console.error('插入数据库错误:', insertError)
      return NextResponse.json({ error: '保存失败，请稍后重试' }, { status: 500 })
    }

    // ── 更新用户风格向量（后置操作，失败不阻断保存）──
    // 公式：new = 0.8 * old + 0.2 * script_embedding
    // 使风格向量随用户新保存素材实时微调
    await updateUserStyleVector(supabase, user.id, embedding)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
