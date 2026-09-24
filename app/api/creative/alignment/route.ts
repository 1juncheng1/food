import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/apiAuth'
import { normalizeRevisionPlan } from '@/lib/creative/workAgent'
import { verifyFeedbackAlignment } from '@/lib/creative/feedbackAlignment'
import { hasEnoughFor } from '@/lib/aiCost'
import { INSUFFICIENT_POINTS_MESSAGE } from '@/lib/balance'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

// ============================================================
// POST /api/creative/alignment —— 反馈方向一致性校验
//
// 回答一个之前没人回答的问题：「按用户反馈改出来的新版本，真的改到了点上吗？」
//
// 入参里只需要一个版本行 id：正文一律从库里取（不信任客户端 content），
// 改动前的版本默认取同一项目里版本号小于当前的最新一版。
// 修改点 / 保持项优先用客户端传的（前端此刻手上有完整上下文），
// 缺失时回落到该版本行落库的 revision_plan，再没有才报 400。
// ============================================================

interface AlignmentBody {
  /** 待校验的新版本行 id（generation_history.id） */
  generationId?: unknown
  /** 改动前的版本行 id；不传则自动取上一版 */
  baseVersionId?: unknown
  /** 用户反馈原文；不传则用该版本行落库的 user_feedback */
  freeText?: unknown
  /** 方向名 / 方案名 */
  intentLabel?: unknown
  /** 要核对的修改点 */
  targets?: unknown
  /** 承诺保持不变的内容 */
  preserveItems?: unknown
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function strArr(v: unknown, max: number, len: number): string[] {
  if (!Array.isArray(v)) return []
  return (v as unknown[]).map((x) => str(x, len)).filter(Boolean).slice(0, max)
}

export async function POST(req: Request) {
  try {
    // 鉴权走统一入口：网络故障 → 503（不踢用户），凭证失效 → 401
    const auth = await authenticateRequest(req)
    if (!auth.ok) return auth.response
    const { supabase, userId } = auth

    const body = (await req.json().catch(() => ({}))) as AlignmentBody
    const generationId = str(body.generationId, 200)
    if (!generationId) return NextResponse.json({ error: '缺少版本标识' }, { status: 400 })
    const baseVersionId = str(body.baseVersionId, 200)
    const intentLabel = str(body.intentLabel, 40)

    // ── 新版本正文（服务端权威来源）──
    const { data: nv, error: nvErr } = await supabase
      .from('generation_history')
      .select('id, user_id, project_id, version_number, sample_text, user_feedback, revision_plan')
      .eq('id', generationId)
      .maybeSingle()
    if (nvErr || !nv) return NextResponse.json({ error: '作品版本不存在' }, { status: 404 })
    const newRow = nv as Record<string, unknown>
    if (newRow.user_id !== userId) {
      return NextResponse.json({ error: '无权访问该作品' }, { status: 403 })
    }
    const after = typeof newRow.sample_text === 'string' ? newRow.sample_text : ''
    if (!after) return NextResponse.json({ error: '作品内容为空，无法校验' }, { status: 400 })

    // ── 改动前的正文 ──
    let before = ''
    if (baseVersionId) {
      const { data } = await supabase
        .from('generation_history')
        .select('sample_text')
        .eq('id', baseVersionId)
        .maybeSingle()
      const r = data as Record<string, unknown> | null
      if (typeof r?.sample_text === 'string') before = r.sample_text
    }
    if (!before && newRow.project_id) {
      // 没指定基底就取同一项目里版本号更小的最新一版
      const { data } = await supabase
        .from('generation_history')
        .select('sample_text')
        .eq('project_id', newRow.project_id as string)
        .lt('version_number', Number(newRow.version_number ?? 0) || 0)
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle()
      const r = data as Record<string, unknown> | null
      if (typeof r?.sample_text === 'string') before = r.sample_text
    }
    if (!before) {
      return NextResponse.json({ error: '找不到改动前的版本，无法校验' }, { status: 400 })
    }

    // ── 验收标准：客户端传入优先，缺失时回落到落库的方案 ──
    const plan = normalizeRevisionPlan(newRow.revision_plan)
    const targets = strArr(body.targets, 6, 60)
    const fromPlan = plan
      ? [plan.title, ...(plan.modificationArea ?? [])].map((t) => str(t, 60)).filter(Boolean)
      : []
    const finalTargets = (targets.length ? targets : fromPlan).slice(0, 6)
    const preserveItems = strArr(body.preserveItems, 4, 40)
    const finalPreserve = (
      preserveItems.length ? preserveItems : (plan?.preserveItems ?? []).map((p) => str(p, 40)).filter(Boolean)
    ).slice(0, 4)

    // 反馈原文是验收的基准，必须有：客户端没传就取落库的 user_feedback
    const freeText = str(body.freeText, 2000) || str(newRow.user_feedback, 2000)
    if (!freeText) {
      return NextResponse.json({ error: '缺少用户反馈原文，无法校验方向' }, { status: 400 })
    }

    // ── 调用前余额预检（Phase 4）─────────────────────────────────
    // 本端点的语义是"失败即静默跳过校验"（返回 null 而不是报错）。
    // 一旦接了计费，余额不足会让校验凭空消失，用户却不知道为什么——
    // 所以在这里先把话说明白：余额不够就直接告诉用户去充值。
    // 真正的并发安全仍由 LLM 层的预扣保证，这里只是把文案说准。
    const budget = await hasEnoughFor(supabase, userId, 'diagnosis')
    if (!budget.ok) {
      return NextResponse.json(
        { error: INSUFFICIENT_POINTS_MESSAGE, code: 'insufficient_balance' },
        { status: 402 }
      )
    }

    const report = await verifyFeedbackAlignment(
      {
        freeText,
        intentLabel: intentLabel || plan?.title || undefined,
        targets: finalTargets,
        preserveItems: finalPreserve,
        before,
        after,
      },
      { supabase, userId, refId: `alignment:${generationId}` }
    )

    // report 为 null 表示校验不可用（LLM 失败等）——这是降级不是错误，
    // 不能返回 5xx：新版本已经落库了，校验只是锦上添花。
    return NextResponse.json({ ok: true, report })
  } catch (e) {
    console.error('alignment 路由异常:', e)
    return NextResponse.json({ error: '校验失败，请重试' }, { status: 500 })
  }
}
