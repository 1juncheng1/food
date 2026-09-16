import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { parseDiagnosis } from '@/lib/creative/diagnosis'
import { recordVersionSignal } from '@/lib/creative/styleLearning'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

interface FeedbackBody {
  generationId?: unknown
  feedbackType?: unknown
  editedContent?: unknown
  topic?: unknown
  identityLabel?: unknown
  style?: unknown
  category?: unknown
  systemPrompt?: unknown
  sampleText?: unknown
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

const VALID_TYPES = ['like', 'dislike', 'edit', 'regenerate'] as const
type FeedbackType = (typeof VALID_TYPES)[number]

/** submit_feedback RPC 的 jsonb 返回结构 */
interface RpcResult {
  success?: boolean
  error?: string
  code?: number
  generationId?: string
  /** like/dislike 再次点击取消时为 null */
  feedbackStatus?: string | null
}

/**
 * 从 Authorization 头提取 Bearer token，验证用户身份。
 * 项目 session 存 localStorage，前端需显式把 access_token 传上来。
 */
async function authenticate(req: Request) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) return null

  const supabase = createServerClient(token)
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token)
  if (error || !user) return null

  return { supabase, userId: user.id }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as FeedbackBody

    // ── 验证用户身份（从 Authorization 头读取 token）──
    const auth = await authenticate(req)
    if (!auth) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }

    // ── 入参校验（快速失败；submit_feedback 函数内还有兜底校验）──
    const feedbackType = body.feedbackType as FeedbackType
    if (!VALID_TYPES.includes(feedbackType)) {
      return NextResponse.json({ error: '无效的反馈类型' }, { status: 400 })
    }
    const editedContent = feedbackType === 'edit' ? str(body.editedContent, 100000) : null
    if (feedbackType === 'edit' && !editedContent) {
      return NextResponse.json({ error: '请填写修改后的内容' }, { status: 400 })
    }

    // ── 事务写入：补建历史 + 插入反馈 + 更新状态，在 submit_feedback 单次调用内原子完成 ──
    const { data, error } = await auth.supabase.rpc('submit_feedback', {
      p_generation_id: str(body.generationId, 100) || null,
      p_feedback_type: feedbackType,
      p_edited_content: editedContent,
      p_topic: str(body.topic, 500) || null,
      p_identity_label: str(body.identityLabel, 200) || null,
      p_style: str(body.style, 500) || null,
      p_category: str(body.category, 100) || null,
      p_system_prompt: str(body.systemPrompt, 20000) || null,
      p_sample_text: str(body.sampleText, 100000) || null,
    })
    if (error) {
      console.error('submit_feedback RPC 失败:', error)
      return NextResponse.json({ error: `保存反馈失败: ${error.message}` }, { status: 500 })
    }

    // 函数内用 jsonb 返回业务错误（校验失败/记录不存在等）
    const result = (typeof data === 'string' ? JSON.parse(data) : data) as RpcResult | null
    if (!result?.success) {
      const status = typeof result?.code === 'number' ? result.code : 500
      return NextResponse.json({ error: result?.error ?? '保存反馈失败' }, { status })
    }

    // ── 阶段 5：👍/👎 作为个人风格学习信号（edit/regenerate 不入维度；取消不记；失败静默）──
    if (
      (feedbackType === 'like' || feedbackType === 'dislike') &&
      result.feedbackStatus !== null
    ) {
      const targetId = result.generationId || str(body.generationId, 100)
      if (targetId) {
        const { data: histRow } = await auth.supabase
          .from('generation_history')
          .select('analysis')
          .eq('id', targetId)
          .maybeSingle()
        if (histRow) {
          recordVersionSignal(
            auth.supabase,
            auth.userId,
            feedbackType,
            parseDiagnosis((histRow as Record<string, unknown>).analysis)
          )
        }
      }
    }

    return NextResponse.json({
      ok: true,
      generationId: result.generationId,
      feedbackStatus: result.feedbackStatus,
    })
  } catch (error) {
    console.error('feedback API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

// ── GET：查询某篇作品的反馈状态（页面刷新后恢复用）──
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const genId = searchParams.get('id')
    if (!genId) {
      return NextResponse.json({ error: '缺少 id' }, { status: 400 })
    }

    const auth = await authenticate(req)
    if (!auth) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }

    const { data: history, error } = await auth.supabase
      .from('generation_history')
      .select('feedback_status')
      .eq('id', genId)
      .maybeSingle()

    if (error || !history) {
      return NextResponse.json({ exists: false, feedbackStatus: null })
    }

    return NextResponse.json({ exists: true, feedbackStatus: history.feedback_status })
  } catch (error) {
    console.error('feedback GET 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
