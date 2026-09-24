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
import { authFailureResponse } from '@/lib/apiAuth'
import { toCategory } from '@/lib/constants'
import { rateLimit } from '@/lib/rateLimit'
import { parseVector, weightedAverage } from '@/lib/styleVector'
import {
  analyzeKnowledge,
  reAnalyzeKnowledge,
  type ReAnalyzeKnowledgeInput,
} from '@/lib/creative/knowledgeAnalyzer'
import { normalizeKnowledgeItem, type KnowledgeItem } from '@/lib/creative/knowledgeItem'
import { MATERIAL_TYPES, type MaterialType } from '@/lib/creative/material'

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
  /** Phase 2 新增：素材类型（9 种枚举之一，可选） */
  materialType?: MaterialType
  /** Phase 2 新增：所属分组 ID（null=不分组；可选） */
  groupId?: string | null
  /** Phase 2 新增：素材来源（任意字符串，可选） */
  source?: string
  /**
   * 确认保存时由前端回传的、用户已确认的 KnowledgeItem。
   * 传入且有效时直接清洗入库，不再重复调用 LLM
   * （首次分析已生成过；重复调用既浪费 3~36s，还会因 temperature 随机性
   *   导致"用户确认的是 A、入库的是 B"的一致性问题）。
   * 不传时保留旧行为（服务端重新分析），向后兼容。
   */
  knowledge?: unknown
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
      return authFailureResponse(userError)
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

    // ── Phase 2 新增字段解析与校验（materialType/groupId/source）──
    const materialType: MaterialType | undefined = body.materialType
    const groupId: string | null = body.groupId ?? null
    const source: string | null = typeof body.source === 'string' ? body.source : null

    if (
      materialType !== undefined &&
      !(MATERIAL_TYPES as readonly string[]).includes(materialType)
    ) {
      return NextResponse.json(
        { error: '素材类型不合法，请从 9 种类型中选择' },
        { status: 400 }
      )
    }

    if (groupId) {
      const { data: groupRow, error: groupError } = await supabase
        .from('material_groups')
        .select('id')
        .eq('id', groupId)
        .eq('user_id', user.id)
        .maybeSingle()
      if (groupError || !groupRow) {
        return NextResponse.json(
          { error: '所选分组不存在或无权访问' },
          { status: 400 }
        )
      }
    }
    // source 直接存，不做枚举校验

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

      const result = await reAnalyzeKnowledge(
        {
          content: content.trim(),
          previousKnowledge: prevKnowledge,
          userCorrection: correction,
        },
        // 计费上下文。注意这里**不做余额预检拦截**：本端点 LLM 失败时
        // 会降级为"照常保存素材"，余额不足同样走这条降级——
        // 若改成 402，用户会连素材都存不了，那是把增强功能变成了主流程的拦路石。
        { supabase, userId: user.id, refId: `reanalyze:${crypto.randomUUID()}` }
      )

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

    // ── 快路径：确认保存时前端回传了已确认的 knowledge ────────
    // 经 normalizeKnowledgeItem 白名单清洗（枚举/长度/类型）后直接入库，
    // 跳过第二次 LLM 调用。embedding 仍在 saveScript 内由服务端生成，不可伪造。
    if (save && body.knowledge !== undefined && body.knowledge !== null) {
      const confirmedKnowledge = normalizeKnowledgeItem(body.knowledge)
      if (!confirmedKnowledge) {
        return NextResponse.json(
          { error: 'AI 分析结果无效，请重新分析后再保存' },
          { status: 400 }
        )
      }
      if (clarifications && clarifications.length > 0) {
        confirmedKnowledge.clarification_asked = true
      }
      const insertErr = await saveScript(
        supabase,
        user.id,
        content,
        category,
        confirmedKnowledge,
        materialType,
        groupId,
        source
      )
      if (insertErr) {
        return NextResponse.json({ error: '保存失败' }, { status: 500 })
      }
      return NextResponse.json({
        stage: 'saved',
        knowledge: confirmedKnowledge,
      })
    }

    // ── 调用 LLM 分析 ──────────────────────────────────────
    const result = await analyzeKnowledge(
      {
        content: content.trim(),
        category: category ?? undefined,
        clarifications,
      },
      // 同上：只计费，不拦截（失败降级为保存无 knowledge 的素材）
      { supabase, userId: user.id, refId: `analyze:${crypto.randomUUID()}` }
    )

    // 降级：LLM 失败 → 直接保存无 knowledge 的素材（不阻断用户）
    if (result.degraded) {
      if (save) {
        const insertErr = await saveScript(
          supabase,
          user.id,
          content,
          category,
          null,
          materialType,
          groupId,
          source
        )
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
        const insertErr = await saveScript(
          supabase,
          user.id,
          content,
          category,
          null,
          materialType,
          groupId,
          source
        )
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
      const insertErr = await saveScript(
        supabase,
        user.id,
        content,
        category,
        knowledge,
        materialType,
        groupId,
        source
      )
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
// Phase 2 扩展：materialType/groupId/source 三字段写入

async function saveScript(
  supabase: any,
  userId: string,
  content: string,
  category: string | null,
  knowledge: ReturnType<typeof normalizeKnowledgeItem>,
  materialType: MaterialType | undefined,
  groupId: string | null,
  source: string | null
): Promise<string | null> {
  // 第一轮并行（互不依赖）：bge-m3 embedding 生成 ｜ 现有风格向量预取。
  // Supabase 跨境单轮 RTT 约 1~2s，串行 4 步（emb→ins→sel→ups）实测 4.9s，
  // 预取 select 后降为 3 步（emb‖sel→ins→ups）。
  const [embedding, stylePrefetch] = await Promise.all([
    generateEmbedding(content),
    // 注意：Supabase query builder 是 thenable 而非完整 Promise（没有 .catch），
    // 必须用 Promise.resolve 包一层
    Promise.resolve(
      supabase
        .from('style_profiles')
        .select('style_vector, tone_tags, pace_preference, common_opening, avg_length, source')
        .eq('user_id', userId)
        .maybeSingle()
    ).catch((e: unknown) => {
      console.error('风格向量预取失败:', e)
      return { data: null, error: e as Error }
    }),
  ])

  const { error } = await supabase.from('scripts').insert({
    user_id: userId,
    content: content.trim(),
    type: 'text',
    category,
    embedding,
    knowledge,
    material_type: materialType ?? null,
    group_id: groupId,
    source,
  })

  if (error) {
    console.error('保存素材失败:', error)
    return error.message
  }

  // 后置：用预取结果加权更新用户风格向量（失败不阻断，语义与 updateUserStyleVector 一致，
  // 区别仅在于复用上面已完成的 select，不再重复查询）
  if (embedding && stylePrefetch && !stylePrefetch.error) {
    try {
      const existing = stylePrefetch.data
      const updatedVec = weightedAverage(parseVector(existing?.style_vector), embedding)
      const { error: upsertErr } = await supabase.from('style_profiles').upsert(
        {
          user_id: userId,
          style_vector: updatedVec,
          tone_tags: existing?.tone_tags ?? [],
          pace_preference: existing?.pace_preference ?? '未知',
          common_opening: existing?.common_opening ?? '未知',
          avg_length: existing?.avg_length ?? 0,
          source: existing?.source ?? 'auto',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      )
      if (upsertErr) console.error('更新风格向量失败:', upsertErr)
    } catch (e) {
      console.error('updateUserStyleVector 失败:', e)
    }
  }

  return null
}

/** 生成 bge-m3 向量；任何失败均返回 null（素材仍可无向量入库，不阻断主流程） */
async function generateEmbedding(content: string): Promise<number[] | null> {
  try {
    const embeddingResponse = await fetch('https://api.siliconflow.cn/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'BAAI/bge-m3', input: content }),
    })
    if (!embeddingResponse.ok) return null
    const data = await embeddingResponse.json()
    const emb = data?.data?.[0]?.embedding
    return Array.isArray(emb) ? emb : null
  } catch (e) {
    console.error('embedding 生成失败:', e)
    return null
  }
}
