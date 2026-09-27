// ============================================================
// GET/POST /api/creative/interview —— AI 创作者访谈
//
// GET  （无参数）   → 返回问题列表 + 当前访谈状态
// POST （提交回答） → 写入 style_profiles.creator_declaration
//
// 鉴权：必须登录（访谈是用户私域数据）
// 设计原则：
//   1. 问题集是静态的，不调 LLM（降低延迟和成本）
//   2. 回答写入 jsonb，不新建表
//   3. 允许部分提交（用户可以中途保存，稍后继续）
//   4. 访谈完成后 source='onboarding'，设置页修改后 source='settings'
// ============================================================

import { NextResponse } from 'next/server'
import { authenticateRequest, type AuthResult } from '@/lib/apiAuth'
import { guardRateLimit } from '@/lib/rateLimit'
import {
  INTERVIEW_QUESTIONS,
  CURRENT_INTERVIEW_VERSION,
  aggregateAnswers,
  type InterviewQuestion,
} from '@/lib/creative/interviewQuestions'
import {
  normalizeCreatorDeclaration,
  isDeclarationComplete,
  isDeclarationEmpty,
  type CreatorDeclaration,
  type DeclarationDimension,
} from '@/lib/creative/creatorDeclaration'

export const dynamic = 'force-dynamic'

// ── 鉴权：复用 style-profile 的鉴权函数 ─────────────────────
/**
 * 鉴权统一走 lib/apiAuth：网络故障 → 503「网络异常」（已登录用户不得踢），
 * 凭证失效 → 401。旧的内联 getUser + 一律返回 null 会把网络抖动伪装成"未登录"。
 */
async function authenticate(req: Request): Promise<AuthResult> {
  return authenticateRequest(req)
}

// ── GET：返回问题列表 + 当前访谈状态 ───────────────────────
export async function GET(req: Request) {
  try {
    const auth = await authenticate(req)
    if (!auth.ok) return auth.response

    // 查询当前 declaration
    const { data: profile } = await auth.supabase
      .from('style_profiles')
      .select('creator_declaration')
      .eq('user_id', auth.userId)
      .maybeSingle()

    const declaration = normalizeCreatorDeclaration(
      (profile as Record<string, unknown> | null)?.creator_declaration
    )

    // 增量补问：?dimensions=background,value_statement → 只返回这几问。
    // 老用户新增维度时只补缺的，不要求重答整套问题。
    const onlyRaw = new URL(req.url).searchParams.get('dimensions')
    const requested = (onlyRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const questions =
      requested.length > 0
        ? INTERVIEW_QUESTIONS.filter((q) => requested.includes(q.dimension))
        : INTERVIEW_QUESTIONS

    return NextResponse.json({
      // 问题列表（静态，前端直接渲染）
      questions: questions as unknown as Array<
        Omit<InterviewQuestion, 'options'> & { options: Array<{ value: string; label: string; description?: string }> }
      >,
      // 允许"完成"的最低回答数。补问只展示 3 问时不能还要求 6 个 ——
      // 否则用户答完所有问题却点不了完成。
      requiredCount: Math.min(6, questions.length),
      currentVersion: CURRENT_INTERVIEW_VERSION,
      // 当前访谈状态
      status: {
        // 复用 isDeclarationEmpty：新增维度后不要再手写一份字段清单，
        // 否则每次扩维都要记得同步改这里（此前就是 8 个字段的复制粘贴）。
        interviewed: !isDeclarationEmpty(declaration),
        complete: isDeclarationComplete(declaration),
        declaration,
      },
    })
  } catch (error) {
    console.error('interview GET 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

// ── POST：提交访谈回答 ──────────────────────────────────────
interface SubmitBody {
  answers?: Array<{ dimension: DeclarationDimension; value: string }>
  /** 是否完成访谈（true 时标记 source='onboarding'） */
  complete?: boolean
  /** 提交来源：onboarding（首次）/ settings（设置页修改） */
  source?: 'onboarding' | 'settings'
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export async function POST(req: Request) {
  try {
    const auth = await authenticate(req)
    if (!auth.ok) return auth.response

    // 限流（跨实例）：问卷提交会写 style_profiles，属高频写操作
    const limited = await guardRateLimit(auth.userId, 'creative-interview', 30, 60_000)
    if (limited) return limited

    const body = (await req.json().catch(() => ({}))) as SubmitBody
    const answersRaw = Array.isArray(body.answers) ? body.answers : []
    const isComplete = !!body.complete
    const source = str(body.source, 20) === 'settings' ? 'settings' : 'onboarding'

    // 聚合回答为 declaration 字段
    const aggregated = aggregateAnswers(
      answersRaw.map((a) => ({
        dimension: a.dimension,
        value: str(a.value, 200),
      }))
    )

    if (Object.keys(aggregated).length === 0) {
      return NextResponse.json({ error: '请至少回答一个问题' }, { status: 400 })
    }

    // 读取已有 declaration（合并而非覆盖，支持部分提交）
    const { data: existing } = await auth.supabase
      .from('style_profiles')
      .select('creator_declaration')
      .eq('user_id', auth.userId)
      .maybeSingle()
    const existingDecl = normalizeCreatorDeclaration(
      (existing as Record<string, unknown> | null)?.creator_declaration
    )

    // 合并：新回答覆盖旧回答
    const merged: CreatorDeclaration = {
      ...existingDecl,
      ...aggregated,
      interviewedAt: new Date().toISOString(),
      interviewVersion: CURRENT_INTERVIEW_VERSION,
      source: source === 'settings' ? 'settings' : (existingDecl.source ?? 'onboarding'),
    }

    // upsert 写入
    const { error: upsertErr } = await auth.supabase
      .from('style_profiles')
      .upsert(
        {
          user_id: auth.userId,
          creator_declaration: merged,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      )

    if (upsertErr) {
      console.error('访谈回答写入失败:', upsertErr.message)
      return NextResponse.json({ error: '保存失败' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      declaration: merged,
      complete: isComplete ? isDeclarationComplete(merged) : isDeclarationComplete(merged),
    })
  } catch (error) {
    console.error('interview POST 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
