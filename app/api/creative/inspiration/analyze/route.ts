// ============================================================
// POST /api/creative/inspiration/analyze —— AI 灵感分析与转化
//
// 输入：{ raw_input: string }
// 输出：{ analysis: InspirationAnalysis }
//
// 流程：
//   1. 可选鉴权：游客可分析（无素材召回，无数据沉淀）；登录用户额外召回素材
//   2. 限流：10 次/分钟（与 plan 同口径）
//   3. 调 analyzeInspiration（DeepSeek LLM，强制 JSON）
//   4. 登录用户：生成 embedding → match_scripts RPC 召回 Top 3 素材 ID
//   5. 装配 InspirationAnalysis 返回；LLM 失败返回 502，前端降级为无分析直接走 plan
// ============================================================

import { NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rateLimit'
import { authenticateWithToken, generateEmbedding } from '@/lib/storage'
import { aiFailureResponse } from '@/lib/apiAuth'
import { hasEnoughFor } from '@/lib/aiCost'
import { INSUFFICIENT_POINTS_MESSAGE } from '@/lib/points'
import {
  analyzeInspiration,
  recallMaterials,
} from '@/lib/creative/inspirationAnalyzer'
import type { InspirationAnalysis } from '@/lib/creative/inspirationAnalyzer'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000

interface RequestBody {
  raw_input?: unknown
}

function str(v: unknown, maxLen: number): string {
  return typeof v === 'string' ? v.trim().slice(0, maxLen) : ''
}

export async function POST(req: Request) {
  try {
    // ── 强制鉴权：游客不可使用灵感分析 ──
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const auth = await authenticateWithToken(token, '请先登录后再分析灵感')
    if (!auth.ok) return auth.response

    // ── 限流：登录按 userId ──
    const rateKey = `inspiration:${auth.userId}`
    const limit = rateLimit(rateKey, RATE_LIMIT, RATE_WINDOW_MS)
    if (!limit.ok) {
      return NextResponse.json(
        { error: `操作太频繁，请 ${limit.retryAfterSec} 秒后再试` },
        { status: 429 }
      )
    }

    const body = (await req.json().catch(() => ({}))) as RequestBody
    const rawInput = str(body.raw_input, 2000)
    if (!rawInput) {
      return NextResponse.json({ error: '请填写灵感内容' }, { status: 400 })
    }
    if (rawInput.length < 2) {
      return NextResponse.json({ error: '灵感内容太短，至少 2 个字' }, { status: 400 })
    }

    // ── 余额预检 ──
    // 只为让余额不足时返回 402「请充值」，而不是含糊的 502「分析失败」。
    // 真正的扣费在 LLM 层的预扣那一刀（行锁原子，并发安全）。
    const budget = await hasEnoughFor(auth.supabase, auth.userId, 'diagnosis')
    if (!budget.ok) {
      return NextResponse.json(
        { error: INSUFFICIENT_POINTS_MESSAGE, code: 'insufficient_balance' },
        { status: 402 }
      )
    }

    // ── 调 LLM 分析（计费：预扣 → 按真实用量结算 / 失败全额退）──
    const result = await analyzeInspiration(rawInput, {
      supabase: auth.supabase,
      userId: auth.userId,
      refId: crypto.randomUUID(),
    })
    if (!result) {
      return await aiFailureResponse('灵感分析失败，请稍后重试或直接进入创作方案')
    }

    // ── 登录用户：召回相关素材（失败降级为空数组，不阻塞分析返回）──
    let recalledMaterialIds: string[] = []
    let recalledMaterials: Array<{ id: string; content: string; similarity: number }> = []
    if (auth) {
      const embedding = await generateEmbedding(rawInput)
      if (embedding) {
        const recalled = await recallMaterials(
          auth.supabase,
          auth.userId,
          embedding,
          3
        )
        recalledMaterials = recalled
        recalledMaterialIds = recalled.map((r) => r.id)
      }
    }

    const analysis: InspirationAnalysis = {
      raw_input: rawInput,
      input_type: result.input_type,
      value_assessment: result.value_assessment,
      optimization_suggestions: result.optimization_suggestions,
      recalled_material_ids: recalledMaterialIds,
      analyzed_at: new Date().toISOString(),
    }

    return NextResponse.json({
      analysis,
      // 额外返回召回素材预览（前端展示用，不落 inspiration_context）
      recalled_materials: recalledMaterials.map((m) => ({
        id: m.id,
        preview: m.content.slice(0, 120) + (m.content.length > 120 ? '…' : ''),
        similarity: Math.round(m.similarity * 100),
      })),
    })
  } catch (error) {
    console.error('inspiration analyze API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
