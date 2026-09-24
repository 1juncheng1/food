// ============================================================
// /api/materials/retrieve —— Material Library 2.0 Phase 3 素材召回 API
//
// POST：纯主题向量召回 + selected 强制置顶，供 Phase 4 创作前"素材选择步骤"调用。
//   body: {
//     currentTopic: string（必填，≤500 字）
//     currentIntent?: string
//     currentContext?: string
//     selectedMaterialIds?: string[]（≤10）
//     reasonMode?: 'template' | 'llm'（默认 template）
//   }
//
// 鉴权：Bearer token → supabase.auth.getUser()（401）
// 限流：template 10/min、llm 5/min（第 6 次 llm → 429 + Retry-After）
// 降级：服务内部已全降级（embedding/LLM 失败不 5xx），正常返回 { materials, meta }
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import { rateLimit } from '@/lib/rateLimit'
import { retrieveMaterials, MAX_SELECTED } from '@/lib/material/retrieval'
import { recordSuggestedByAi } from '@/lib/material/usageWriter'
import type { RelevanceReasonMode } from '@/lib/creative/material'

export const maxDuration = 30

const TOPIC_MAX_LEN = 500
const INTENT_MAX_LEN = 100
const CONTEXT_MAX_LEN = 1000

export async function POST(req: Request) {
  try {
    // ── 鉴权 ──
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const supabase = createServerClient(token)
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser()
    if (userError || !user) {
      return authFailureResponse(userError)
    }

    // ── body 解析与校验 ──
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
    }
    const b = (body ?? {}) as Record<string, unknown>

    const currentTopic =
      typeof b.currentTopic === 'string' ? b.currentTopic.trim().slice(0, TOPIC_MAX_LEN) : ''
    if (!currentTopic) {
      return NextResponse.json(
        { error: 'currentTopic 必须是非空字符串' },
        { status: 400 }
      )
    }

    const reasonMode: RelevanceReasonMode =
      b.reasonMode === undefined ? 'template' : (b.reasonMode as RelevanceReasonMode)
    if (reasonMode !== 'template' && reasonMode !== 'llm') {
      return NextResponse.json(
        { error: "reasonMode 只接受 'template' 或 'llm'" },
        { status: 400 }
      )
    }

    let selectedMaterialIds: string[] | undefined
    if (b.selectedMaterialIds !== undefined) {
      if (
        !Array.isArray(b.selectedMaterialIds) ||
        b.selectedMaterialIds.some((id) => typeof id !== 'string')
      ) {
        return NextResponse.json(
          { error: 'selectedMaterialIds 必须是字符串数组' },
          { status: 400 }
        )
      }
      if (b.selectedMaterialIds.length > MAX_SELECTED) {
        return NextResponse.json(
          { error: `selectedMaterialIds 最多 ${MAX_SELECTED} 个` },
          { status: 400 }
        )
      }
      selectedMaterialIds = b.selectedMaterialIds as string[]
    }

    const currentIntent =
      typeof b.currentIntent === 'string'
        ? b.currentIntent.trim().slice(0, INTENT_MAX_LEN)
        : undefined
    const currentContext =
      typeof b.currentContext === 'string'
        ? b.currentContext.trim().slice(0, CONTEXT_MAX_LEN)
        : undefined

    // ── 限流：LLM 模式 5/min（成本敏感），模板模式 10/min ──
    const rl =
      reasonMode === 'llm'
        ? rateLimit(`materials-retrieve-llm:${user.id}`, 5, 60_000)
        : rateLimit(`materials-retrieve:${user.id}`, 10, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    // ── 召回（内部全降级，正常不抛错） ──
    const { materials, meta } = await retrieveMaterials(
      supabase,
      {
        userId: user.id,
        currentTopic,
        ...(currentIntent ? { currentIntent } : {}),
        ...(currentContext ? { currentContext } : {}),
        ...(selectedMaterialIds ? { selectedMaterialIds } : {}),
      },
      // 计费上下文**只在 reasonMode='llm' 时携带**：template 模式零 LLM，
      // 带上它既没有任何作用，也会让"这一层到底会不会花钱"变得含糊。
      {
        reasonMode,
        ...(reasonMode === 'llm'
          ? { billing: { supabase, userId: user.id, refId: `retrieve:${crypto.randomUUID()}` } }
          : {}),
      }
    )

    // Material Library 2.0 Phase 5：为自动召回项写 suggested_by_ai=true
    // 失败静默降级，不阻断 API 返回（void 触发）
    const selectedIdSet = new Set(selectedMaterialIds ?? [])
    const autoPickedIds = materials
      .filter((m) => !selectedIdSet.has(m.materialId))
      .map((m) => m.materialId)
    if (autoPickedIds.length > 0) {
      void recordSuggestedByAi(user.id, autoPickedIds)
    }

    return NextResponse.json({ materials, meta })
  } catch (error) {
    console.error('materials retrieve API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
