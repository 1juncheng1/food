// ============================================================
// POST /api/creative/analyze-feedback —— Feedback Analyzer
//
// 接收用户自由反馈 + 当前作品正文，输出结构化优化蓝图。
// 登录用户：反馈 + 分析结果落 generation_feedback 表（free_text + analysis_result）
// 游客：纯返回分析结果，不落库
//
// 与 /api/feedback 职责分离：
//   /api/feedback → like/dislike/edit/regenerate 四种枚举反馈
//   /api/creative/analyze-feedback → 自由文本反馈 + AI 分析
// ============================================================

import { NextResponse } from 'next/server'
import { authenticateWithToken } from '@/lib/storage'
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

export async function POST(req: Request) {
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

    // 可选鉴权：登录则落库，游客纯返回
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const auth = token ? await authenticateWithToken(token) : null

    const generationId = str(body.generationId, 200)
    const topic = str(body.topic, 500)

    // ── 调 LLM 分析反馈 ──
    const analysis: FeedbackAnalysis | null = await analyzeFeedback({
      freeText,
      currentContent,
      topic: topic || undefined,
      diagnosis: body.diagnosis,
    })

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

    // ── 登录用户：落 generation_feedback 表 ──
    if (auth && generationId) {
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
    if (!auth) {
      return NextResponse.json({ error: '身份验证失败' }, { status: 401 })
    }

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
