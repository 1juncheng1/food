import { NextResponse } from 'next/server'
import { withAiDeadline } from '@/lib/aiDeadline'
import { aiFailureResponse, authFailureResponse } from '@/lib/apiAuth'
import { guardRateLimit } from '@/lib/rateLimit'
import { createServerClient } from '@/lib/supabaseServer'
import {
  generateEditPatches,
  normalizeEditPatches,
  type ModificationPatch,
  type PatchGenerationInput,
} from '@/lib/creative/patchEngine'
import { normalizeFeedbackAnalysis } from '@/lib/creative/workAgent'
// 需求 §12：AI 消费必须与积分打通
import { hasEnoughFor } from '@/lib/aiCost'
import { INSUFFICIENT_POINTS_MESSAGE } from '@/lib/balance'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

/**
 * POST /api/creative/patch
 * AI 协作修改系统：根据用户反馈生成段落级修改补丁（不重写全文）。
 *
 * 输入：基底全文 + 反馈原文（+ analyze-feedback 的结构化分析 + 负例/上轮补丁）
 * 输出：
 *   - 成功：{ ok: true, patches, summary, paragraphsTotal }
 *   - 降级：{ ok: false, degraded: true, reason } → 前端走现有全文重写链路并提示
 *
 * 说明：本端点只"生成建议"，不写库；落库与融合在 /api/creative/patch/decide。
 * ownership 不在本端点强制（生成建议无副作用）；decide 落库时做归属校验。
 */

interface PatchBody {
  content?: unknown // 基底全文（登录用户的版本行 sample_text 或客户端当前文本）
  freeText?: unknown // 用户反馈原文
  analysis?: unknown // FeedbackAnalysis（analyze-feedback 输出，可选）
  topic?: unknown
  rejectedPatches?: unknown // 上一轮被拒补丁（负例，可选）
  previousPatches?: unknown // 上一轮补丁（继续调整上下文，可选）
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** 客户端传回的补丁结构不可信，经 normalize 清洗后再入 prompt */
function sanitizePatches(raw: unknown): ModificationPatch[] {
  if (!Array.isArray(raw)) return []
  return normalizeEditPatches({ patches: raw }).patches
}

// 下面的 60 必须等于本文件的 maxDuration。
// generateEditPatches 内部有 2 次尝试，两次预算相加会超出 maxDuration →
// 进程被平台硬杀、预扣退不回。共享一份总预算可避免。见 lib/aiDeadline.ts
async function handlePost(req: Request) {
  try {
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const supabase = createServerClient(token)
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token)
    if (authErr || !user) {
      return authFailureResponse(authErr)
    }

    // 限流（跨实例）：补丁生成要把基底全文 + 反馈原文整篇送进 LLM，
    // 单次输入 token 是全站最高的几个入口之一。
    const limited = await guardRateLimit(user.id, 'creative-patch', 10, 60_000)
    if (limited) return limited

    const body = (await req.json().catch(() => ({}))) as PatchBody
    const content = str(body.content, 100000)
    const freeText = str(body.freeText, 2000)
    if (!content) return NextResponse.json({ error: '缺少文章内容' }, { status: 400 })
    if (!freeText) return NextResponse.json({ error: '缺少修改反馈' }, { status: 400 })

    const input: PatchGenerationInput = {
      content,
      freeText,
      analysis: normalizeFeedbackAnalysis(body.analysis),
      topic: str(body.topic, 200) || undefined,
      rejectedPatches: sanitizePatches(body.rejectedPatches).slice(0, 5),
      previousPatches: sanitizePatches(body.previousPatches).slice(0, 5),
    }

    // ── 调用前余额预检 ────────────────────────────────────────
    // 扣费发生在 generateEditPatches 内部的原子预扣。这里先挡一道，
    // 是为了让余额不足时返回 402「请充值」，而不是把「本次没生成出补丁」
    // 归因为"AI 定位不到段落"——那句降级文案会把用户彻底带偏。
    const budget = await hasEnoughFor(supabase, user.id, 'generation')
    if (!budget.ok) {
      return NextResponse.json(
        { error: INSUFFICIENT_POINTS_MESSAGE, code: 'insufficient_balance' },
        { status: 402 }
      )
    }

    const result = await generateEditPatches(input, {
      supabase,
      userId: user.id,
      refId: crypto.randomUUID(),
    })

    // 降级：超长/单段/两次尝试无有效补丁 → 前端走全文重写链路（提示可见，不静默）
    if (!result) {
      const reason =
        content.length > 12000
          ? '文章过长，暂不支持段落级修改'
          : 'AI 未能稳定定位修改段落，已切换为全文优化模式'
      return NextResponse.json({ ok: false, degraded: true, reason })
    }

    const paragraphsTotal = content.replace(/\r\n/g, '\n').split(/\n\s*\n/).filter((p) => p.trim()).length
    return NextResponse.json({
      ok: true,
      patches: result.patches,
      summary: result.summary,
      paragraphsTotal,
    })
  } catch (e) {
    console.error('补丁生成路由异常:', e)
    return await aiFailureResponse('生成修改建议失败，请重试')
  }
}

export const POST = withAiDeadline(60, handlePost)
