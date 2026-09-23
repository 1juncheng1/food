import { NextResponse } from 'next/server'
import { authFailureResponse } from '@/lib/apiAuth'
import { createServerClient } from '@/lib/supabaseServer'
import {
  generateEditPatches,
  normalizeEditPatches,
  type ModificationPatch,
  type PatchGenerationInput,
} from '@/lib/creative/patchEngine'
import { normalizeFeedbackAnalysis } from '@/lib/creative/workAgent'

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

export async function POST(req: Request) {
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

    const result = await generateEditPatches(input)

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
    return NextResponse.json({ error: '生成修改建议失败，请重试' }, { status: 500 })
  }
}
