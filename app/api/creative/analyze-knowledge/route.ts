// ============================================================
// /api/creative/analyze-knowledge
//
// POST 三种模式：
//   阶段 A（不传 clarifications）：
//     LLM 分析素材 → 返回 { stage:'clarify', questions } 或 { stage:'ready', knowledge }
//   阶段 B（传 clarifications）：
//     LLM 基于用户回答生成 KnowledgeItem → 返回 { stage:'ready', knowledge }
//   用户纠错（mode='re_analyze'）：
//     LLM 基于 previous_knowledge + correction 重新生成 → 返回 { stage:'ready', knowledge }
//     不触发 save（前端在纠错完成后统一保存）
//
// 同时承担素材入库：
//   传 save=true 时，把 content + category + knowledge 写入 scripts 表
//   （复用 bge-m3 embedding 生成 + updateUserStyleVector）
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { toCategory } from '@/lib/constants'
import { rateLimit } from '@/lib/rateLimit'
import { updateUserStyleVector } from '@/lib/styleVector'
import {
  analyzeKnowledge,
  reAnalyzeKnowledge,
  type ReAnalyzeKnowledgeInput,
} from '@/lib/creative/knowledgeAnalyzer'
import { normalizeKnowledgeItem, type KnowledgeItem } from '@/lib/creative/knowledgeItem'

export const maxDuration = 60

const MAX_CONTENT_LENGTH = 10000

interface RequestBody {
  content: string
  category?: string
  clarifications?: Array<{ question_id: string; answer: string }>
  /** 是否写入 scripts 表（阶段 B 完成后传 true） */
  save?: boolean
  /** 用户纠错模式 */
  mode?: 're_analyze'
  /** 纠错模式：上一次 AI 分析结果 */
  previous_knowledge?: KnowledgeItem
  /** 纠错模式：用户指出的错误（自由文本） */
  correction?: string
}

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.split(' ')[1]

    if (!token) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    })

    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError || !user) {
      return NextResponse.json({ error: '用户验证失败' }, { status: 401 })
    }

    const rl = rateLimit(`analyze-knowledge:${user.id}`, 5, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    const body: RequestBody = await req.json()
    const { content, clarifications, save } = body
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

    // ── 用户纠错模式 ────────────────────────────────────────
    if (body.mode === 're_analyze') {
      const prevKnowledge = normalizeKnowledgeItem(body.previous_knowledge)
      const correction = typeof body.correction === 'string' ? body.correction.trim() : ''
      if (!prevKnowledge) {
        return NextResponse.json({ error: '缺少上一次 AI 分析结果' }, { status: 400 })
      }
      if (!correction) {
        return NextResponse.json({ error: '请说明 AI 哪里理解错了' }, { status: 400 })
      }

      const rl2 = rateLimit(`analyze-knowledge:${user.id}:retry`, 3, 60_000)
      if (!rl2.ok) {
        return NextResponse.json(
          { error: '纠错请求过于频繁，请稍后再试' },
          { status: 429, headers: { 'Retry-After': String(rl2.retryAfterSec) } }
        )
      }

      const result = await reAnalyzeKnowledge({
        content: content.trim(),
        previousKnowledge: prevKnowledge,
        userCorrection: correction,
      })

      if (result.degraded || !result.knowledge) {
        return NextResponse.json(
          { error: '重新分析失败，请重试或直接保存' },
          { status: 502 }
        )
      }

      // 纠错模式不触发 save（前端纠错完成后统一调 handleConfirmSave）
      return NextResponse.json({
        stage: 'ready',
        knowledge: result.knowledge,
      })
    }

    // ── 调用 LLM 分析 ──────────────────────────────────────
    const result = await analyzeKnowledge({
      content: content.trim(),
      category: category ?? undefined,
      clarifications,
    })

    // 降级：LLM 失败 → 直接保存无 knowledge 的素材（不阻断用户）
    if (result.degraded) {
      if (save) {
        const insertErr = await saveScript(supabase, user.id, content, category, null)
        if (insertErr) {
          return NextResponse.json({ error: '保存失败' }, { status: 500 })
        }
        return NextResponse.json({
          stage: 'saved',
          degraded: true,
          message: 'AI 分析暂时不可用，素材已保存（未生成知识结构）',
        })
      }
      return NextResponse.json({
        stage: 'error',
        degraded: true,
        message: 'AI 分析暂时不可用，请稍后重试',
      })
    }

    // 场景 A：需要澄清
    if (result.needs_clarification && result.questions) {
      return NextResponse.json({
        stage: 'clarify',
        questions: result.questions,
      })
    }

    // 场景 B：生成 KnowledgeItem
    const knowledge = result.knowledge
    if (!knowledge) {
      // 理论上不会到这里，normalize 已处理，但兜底
      if (save) {
        const insertErr = await saveScript(supabase, user.id, content, category, null)
        if (insertErr) {
          return NextResponse.json({ error: '保存失败' }, { status: 500 })
        }
        return NextResponse.json({
          stage: 'saved',
          degraded: true,
          message: 'AI 分析结果无效，素材已保存（未生成知识结构）',
        })
      }
      return NextResponse.json({
        stage: 'error',
        degraded: true,
        message: 'AI 分析结果无效，请重试',
      })
    }

    // 标记是否问过用户
    if (clarifications && clarifications.length > 0) {
      knowledge.clarification_asked = true
    }

    // 保存到 scripts 表
    if (save) {
      const insertErr = await saveScript(supabase, user.id, content, category, knowledge)
      if (insertErr) {
        return NextResponse.json({ error: '保存失败' }, { status: 500 })
      }
      return NextResponse.json({
        stage: 'saved',
        knowledge,
      })
    }

    // 不保存，只返回 knowledge（让前端先展示确认）
    return NextResponse.json({
      stage: 'ready',
      knowledge,
    })
  } catch (error) {
    console.error('analyze-knowledge API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

// ── 保存素材到 scripts 表（复用 bge-m3 embedding + updateUserStyleVector）──

async function saveScript(
  supabase: any,
  userId: string,
  content: string,
  category: string | null,
  knowledge: ReturnType<typeof normalizeKnowledgeItem>
): Promise<string | null> {
  // 生成 embedding
  let embedding: number[] | null = null
  try {
    const embeddingResponse = await fetch('https://api.siliconflow.cn/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'BAAI/bge-m3', input: content }),
    })
    if (embeddingResponse.ok) {
      const data = await embeddingResponse.json()
      const emb = data?.data?.[0]?.embedding
      if (Array.isArray(emb)) embedding = emb
    }
  } catch (e) {
    console.error('embedding 生成失败:', e)
  }

  const { error } = await supabase.from('scripts').insert({
    user_id: userId,
    content: content.trim(),
    type: 'text',
    category,
    embedding,
    knowledge,
  })

  if (error) {
    console.error('保存素材失败:', error)
    return error.message
  }

  // 后置：更新用户风格向量（失败不阻断）
  if (embedding) {
    try {
      await updateUserStyleVector(supabase, userId, embedding)
    } catch (e) {
      console.error('updateUserStyleVector 失败:', e)
    }
  }

  return null
}
