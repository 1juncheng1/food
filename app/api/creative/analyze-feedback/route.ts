// ============================================================
// POST /api/creative/analyze-feedback —— Feedback Analyzer
//
// 接收用户自由反馈 + 当前作品正文，输出结构化优化蓝图。
// 强制登录：反馈 + 分析结果落 generation_feedback 表（free_text + analysis_result）。
// 游客不可用——这是一次付费 LLM 调用，没有 userId 就既落不了库也计不了费；
// 登录入口统一在首页，游客不该走到这里。
//
// 与 /api/feedback 职责分离：
//   /api/feedback → like/dislike/edit/regenerate 四种枚举反馈
//   /api/creative/analyze-feedback → 自由文本反馈 + AI 分析
// ============================================================

import { NextResponse } from 'next/server'
import { withAiDeadline } from '@/lib/aiDeadline'
import { authenticateWithToken, type AuthOk } from '@/lib/storage'
import { guardRateLimit } from '@/lib/rateLimit'
import { analyzeFeedback } from '@/lib/creative/feedbackAnalyzer'
import { normalizeFeedbackAnalysis, type FeedbackAnalysis } from '@/lib/creative/workAgent'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

interface RequestBody {
  freeText?: unknown
  currentContent?: unknown
  topic?: unknown
  generationId?: unknown // 关联的 generation_history 行 id（落库用）
  diagnosis?: unknown // 当前版本的 AI 诊断报告（可选，辅助分析）
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

// 下面的 30 必须等于本文件的 maxDuration。
// feedbackAnalyzer 内部有 3 次重试，而整条请求只有 25s AI 预算——
// 意味着实际上只有第 1 次尝试能跑完，之后会被主动放弃。
// 这是有意的取舍：放弃 = 不发起 = 不预扣，绝不会产生"退不回的扣费"。
// 想让重试真正生效，应调高本路由的 maxDuration。见 lib/aiDeadline.ts
async function handlePost(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody
    const freeText = str(body.freeText, 2000)
    const currentContent = str(body.currentContent, 100000)

    if (!freeText) {
      return NextResponse.json({ error: '请填写反馈内容' }, { status: 400 })
    }
    if (!currentContent) {
      return NextResponse.json({ error: '缺少当前作品正文' }, { status: 400 })
    }

    // ── 强制鉴权 ──
    // 传了 token 就必须验证出结果：网络故障（503）与凭证过期（401）如实返回，
    // 不悄悄降级成"游客"——否则登录用户会在不知情时跑一条记不了账的调用。
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const auth = await authenticateWithToken(token, '请先登录后再使用反馈分析')
    if (!auth.ok) return auth.response

    // 限流（跨实例）：一次付费 LLM 调用，且正文可达 10 万字（输入 token 很贵）
    const limited = await guardRateLimit(auth.userId, 'analyze-feedback', 5, 60_000)
    if (limited) return limited

    const generationId = str(body.generationId, 200)
    const topic = str(body.topic, 500)

    // ── 调 LLM 分析反馈（计费上下文此时必定存在）──
    const analysis: FeedbackAnalysis | null = await analyzeFeedback(
      {
        freeText,
        currentContent,
        topic: topic || undefined,
        diagnosis: body.diagnosis,
      },
      {
        supabase: auth.supabase,
        userId: auth.userId,
        refId: `analyze-feedback:${crypto.randomUUID()}`,
      }
    )

    if (!analysis) {
      // 失败降级：返回 fallback 分析（custom 方向 + 原文作为 instruction）
      const fallback: FeedbackAnalysis = {
        intentType: 'custom',
        modificationTargets: ['整体优化'],
        optimizationBlueprint: `按用户反馈优化：${freeText}`,
        userIntentSummary: `按你的反馈「${freeText.slice(0, 60)}」优化`,
      }
      return NextResponse.json({
        analysis: fallback,
        degraded: true, // 标记为降级结果
      })
    }

    // ── 落 generation_feedback 表 ──
    if (generationId) {
      const { error: insertErr } = await auth.supabase
        .from('generation_feedback')
        .insert({
          generation_id: generationId,
          user_id: auth.userId,
          feedback_type: 'optimize', // 新增的反馈类型
          free_text: freeText,
          analysis_result: {
            ...analysis,
            analyzedAt: new Date().toISOString(),
          },
        })
      if (insertErr) {
        console.error('反馈写库失败（结果仍返回前端）:', insertErr.message)
      }
    }

    return NextResponse.json({ analysis, degraded: false })
  } catch (error) {
    console.error('analyze-feedback API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

export const POST = withAiDeadline(30, handlePost)

// ── GET：查询某作品版本的反馈历史 ──
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const generationId = searchParams.get('generationId')
    if (!generationId) {
      return NextResponse.json({ error: '缺少 generationId' }, { status: 400 })
    }

    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const auth = await authenticateWithToken(token)
    if (!auth.ok) return auth.response

    const { data, error } = await auth.supabase
      .from('generation_feedback')
      .select('id, generation_id, feedback_type, free_text, analysis_result, created_at')
      .eq('generation_id', generationId)
      .eq('user_id', auth.userId)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      console.error('反馈历史查询失败:', error.message)
      return NextResponse.json({ error: '查询失败' }, { status: 500 })
    }

    const feedbacks = (data ?? [])
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          id: String(r.id ?? ''),
          generationId: String(r.generation_id ?? ''),
          feedbackType: String(r.feedback_type ?? ''),
          freeText: typeof r.free_text === 'string' ? r.free_text : null,
          analysisResult: normalizeFeedbackAnalysis(r.analysis_result),
          createdAt: String(r.created_at ?? ''),
        }
      })
      .filter((f) => f.feedbackType === 'optimize' && f.freeText)

    return NextResponse.json({ feedbacks })
  } catch (error) {
    console.error('analyze-feedback GET 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
