import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { normalizeBlueprint, type CreativeBlueprint } from '@/lib/creative/blueprint'
import { parseDiagnosis, type CreativeDiagnosis } from '@/lib/creative/diagnosis'
import { recordVersionSignal } from '@/lib/creative/styleLearning'

export const maxDuration = 20
export const dynamic = 'force-dynamic'

/** 鉴权 + 项目归属校验，GET/PATCH 共用 */
async function loadOwnedProject(
  req: Request,
  projectId: string
): Promise<
  | { ok: true; supabase: ReturnType<typeof createServerClient>; userId: string }
  | { ok: false; response: NextResponse }
> {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) {
    return { ok: false, response: NextResponse.json({ error: '请先登录' }, { status: 401 }) }
  }
  const supabase = createServerClient(token)
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser(token)
  if (authErr || !user) {
    return { ok: false, response: NextResponse.json({ error: '登录已过期' }, { status: 401 }) }
  }
  const { data: own } = await supabase
    .from('creative_projects')
    .select('id')
    .eq('id', projectId)
    .maybeSingle()
  if (!own) {
    return { ok: false, response: NextResponse.json({ error: '项目不存在' }, { status: 404 }) }
  }
  return { ok: true, supabase, userId: user.id }
}

/**
 * GET /api/creative/projects/[projectId]
 * 创作进化系统阶段 3：返回项目信息 + 全部历史版本（V1/V2/V3…，按版本号正序）。
 * RLS 已保证只能读到自己的项目和版本；这里再做一次显式归属校验。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params
    if (!projectId) {
      return NextResponse.json({ error: '无效的项目 ID' }, { status: 400 })
    }

    const auth = await loadOwnedProject(req, projectId)
    if (!auth.ok) return auth.response

    // 项目（RLS 兜底，显式校验双保险）
    const { data: project, error: projectErr } = await auth.supabase
      .from('creative_projects')
      .select('id, title, topic, status, current_version, created_at, updated_at')
      .eq('id', projectId)
      .maybeSingle()

    if (projectErr) {
      console.error('查询创作项目失败:', projectErr)
      return NextResponse.json({ error: '查询失败' }, { status: 500 })
    }
    if (!project) {
      return NextResponse.json({ error: '项目不存在' }, { status: 404 })
    }

    // 版本列表：按版本号正序，旧版本只读保留
    const { data: versions, error: versionsErr } = await auth.supabase
      .from('generation_history')
      .select(
        'id, version_number, improve_direction, improve_note, user_feedback, sample_text, system_prompt, blueprint, analysis, feedback_status, created_at'
      )
      .eq('project_id', projectId)
      .order('version_number', { ascending: true })

    if (versionsErr) {
      console.error('查询版本列表失败:', versionsErr)
      return NextResponse.json({ error: '查询版本失败' }, { status: 500 })
    }

    return NextResponse.json({
      project,
      versions: (versions ?? []).map((v) => ({
        id: v.id as string,
        versionNumber: v.version_number as number,
        improveDirection: (v.improve_direction as string | null) ?? null,
        improveNote: (v.improve_note as string | null) ?? null,
        // 阶段 4 Work Agent：用户反馈原文（V2+ 才有，V1 为 null）
        userFeedback: (v.user_feedback as string | null) ?? null,
        sampleText: v.sample_text as string,
        systemPrompt: v.system_prompt as string | null,
        blueprint: normalizeBlueprint(v.blueprint) as CreativeBlueprint | null,
        analysis: parseDiagnosis(v.analysis) as CreativeDiagnosis | null,
        feedbackStatus: (v.feedback_status as string | null) ?? null,
        createdAt: v.created_at as string,
      })),
    })
  } catch (error) {
    console.error('creative project GET 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

/**
 * PATCH /api/creative/projects/[projectId]
 * 阶段 5：定稿 / 重新开启迭代。
 * body: { status: 'finalized' | 'active' }
 * 定稿 = 把当前最新版本确认为"最终作品"，并将该版本诊断作为最强偏好信号学习。
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params
    if (!projectId) {
      return NextResponse.json({ error: '无效的项目 ID' }, { status: 400 })
    }
    const auth = await loadOwnedProject(req, projectId)
    if (!auth.ok) return auth.response

    const body = (await req.json().catch(() => ({}))) as { status?: unknown }
    const status = body.status === 'finalized' || body.status === 'active' ? body.status : null
    if (!status) {
      return NextResponse.json({ error: '无效的状态' }, { status: 400 })
    }

    const { data: project, error: updErr } = await auth.supabase
      .from('creative_projects')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', projectId)
      .select('id, status, current_version')
      .single()

    if (updErr || !project) {
      console.error('项目状态更新失败:', updErr)
      return NextResponse.json({ error: '更新失败' }, { status: 500 })
    }

    // 定稿时：读取最终版本的诊断，沉淀为强偏好风格信号（失败静默）
    if (status === 'finalized') {
      const finalVersionId = `${projectId}::v${project.current_version}`
      const { data: finalRow } = await auth.supabase
        .from('generation_history')
        .select('analysis')
        .eq('id', finalVersionId)
        .maybeSingle()
      if (finalRow) {
        recordVersionSignal(auth.supabase, auth.userId, 'finalize', parseDiagnosis(finalRow.analysis))
      }
    }

    return NextResponse.json({ ok: true, status: project.status })
  } catch (error) {
    console.error('creative project PATCH 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
