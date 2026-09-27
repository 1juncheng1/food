import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, type AuthResult } from '@/lib/apiAuth'
import { parseDiagnosis } from '@/lib/creative/diagnosis'
import { recordVersionSignal } from '@/lib/creative/styleLearning'
import { trackEvent } from '@/lib/creative/interest/eventTracker'
import { applyMemoryEvent, parseEditingProfile } from '@/lib/creative/editingMemory'
import { extractEditDiffSignals } from '@/lib/creative/editDiff'

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
/**
 * 鉴权统一走 lib/apiAuth：网络故障 → 503「网络异常」（已登录用户不得踢），
 * 凭证失效 → 401。旧的内联 getUser + 一律返回 null 会把网络抖动伪装成"未登录"。
 */
async function authenticate(req: Request): Promise<AuthResult> {
  return authenticateRequest(req)
}

/**
 * 从「原稿 → 用户改稿」的差异里沉淀编辑偏好。
 *
 * 为什么值得做：edited_content 是**用户亲手写的**内容。它和 AI 生成的正文
 * 不同 —— 把它当信号源不会造成自蒸馏（AI 复读自己），因此它是 editingMemory
 * 目前唯一缺失、也最可信的事件源。此前这份数据只被用来算 revisionCount 统计。
 *
 * 全程 try/catch + void 触发：记忆更新失败绝不阻塞反馈保存主链路。
 */
async function recordEditDiffMemory(
  supabase: SupabaseClient,
  userId: string,
  generationId: string,
  editedContent: string
): Promise<void> {
  try {
    // 原稿取库内的 sample_text（RLS 已限定只能读自己的）
    const { data: row } = await supabase
      .from('generation_history')
      .select('sample_text')
      .eq('id', generationId)
      .maybeSingle()
    const original =
      typeof (row as { sample_text?: unknown } | null)?.sample_text === 'string'
        ? ((row as { sample_text: string }).sample_text ?? '')
        : ''

    const signals = extractEditDiffSignals(original, editedContent)
    if (signals.length === 0) return

    const { data: profileRow } = await supabase
      .from('style_profiles')
      .select('editing_profile')
      .eq('user_id', userId)
      .maybeSingle()
    const nextProfile = applyMemoryEvent(parseEditingProfile(profileRow?.editing_profile), {
      // 用户亲手改过 = 认可这次改动方向；analysis 留空，只让 reasons 生效
      accepted: true,
      // 把差异依据带进 examples，日后能在画像里溯源"这条偏好是怎么来的"
      freeText: signals
        .slice(0, 2)
        .map((s) => s.source)
        .join('；'),
      analysis: null,
      reasons: signals,
    })
    const { error } = await supabase
      .from('style_profiles')
      .upsert({ user_id: userId, editing_profile: nextProfile }, { onConflict: 'user_id' })
    if (error) console.error('feedback：编辑差异记忆更新失败:', error)
  } catch (e) {
    console.error('feedback：编辑差异记忆异常:', e)
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as FeedbackBody

    // ── 验证用户身份（从 Authorization 头读取 token）──
    const auth = await authenticate(req)
    if (!auth.ok) return auth.response

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
      // 服务端日志保留细节；数据库报错可能含表名/策略名，不能回显给客户端
      return NextResponse.json({ error: '保存反馈失败' }, { status: 500 })
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
          .select('analysis, project_id')
          .eq('id', targetId)
          .maybeSingle()
        if (histRow) {
          recordVersionSignal(
            auth.supabase,
            auth.userId,
            feedbackType,
            parseDiagnosis((histRow as Record<string, unknown>).analysis)
          )
          // M1：显式评价事件。👎 仅弱负分（-0.3）——多数时候否定的是生成质量而非主题；
          // project_id 透传给 M2 项目封顶；取消点赞/点踩不发事件
          await trackEvent(auth.supabase, auth.userId, {
            type: feedbackType === 'like' ? 'feedback_like' : 'feedback_dislike',
            targetType: 'generation',
            targetId,
            projectId: (histRow as { project_id?: string | null }).project_id ?? null,
          })
        }
      }
    }

    // M1：编辑/重做 = 迭代投入（弱正信号 0.3）。按天幂等，允许对同一作品反复迭代
    if (feedbackType === 'edit' || feedbackType === 'regenerate') {
      const targetId = result.generationId || str(body.generationId, 100)
      if (targetId) {
        await trackEvent(auth.supabase, auth.userId, {
          type: feedbackType === 'edit' ? 'work_edit' : 'work_regenerate',
          targetType: 'generation',
          targetId,
          topicExcerpt: str(body.topic, 500) || null,
          dailyKey: true,
        })
        // 只有 'edit' 才有改稿可与原稿比对；void 触发，不阻塞反馈响应
        if (feedbackType === 'edit') {
          void recordEditDiffMemory(auth.supabase, auth.userId, targetId, editedContent ?? '')
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
    if (!auth.ok) return auth.response

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
