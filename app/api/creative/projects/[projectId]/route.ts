import { NextResponse } from 'next/server'
import { authFailureResponse } from '@/lib/apiAuth'
import { createServerClient } from '@/lib/supabaseServer'
import { normalizeBlueprint, type CreativeBlueprint } from '@/lib/creative/blueprint'
import { parseDiagnosis, type CreativeDiagnosis } from '@/lib/creative/diagnosis'
import { recordVersionSignal } from '@/lib/creative/styleLearning'
import { normalizeEditPatches } from '@/lib/creative/patchEngine'
import { normalizeRevisionPlan } from '@/lib/creative/workAgent'
import { normalizeInjectedUnits } from '@/lib/creative/knowledgeInject'
import { trackEvent } from '@/lib/creative/interest/eventTracker'
import { runBuild } from '@/lib/creative/interest/builder'

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
    return { ok: false, response: authFailureResponse(authErr) }
  }
  // 显式归属校验：不依赖 RLS 兜底。RLS 一旦被误改/误删策略，
  // 仅按 id 查询会让任意登录用户读写他人项目（IDOR）。
  const { data: own } = await supabase
    .from('creative_projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
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
    // edit_patches / session_id / revision_plan 是 Work Agent 的"为什么改"证据链，
    // 缺了它们版本记录只剩一个结果正文，用户无从复盘（这也是新请求变 visit 的原因之一）
    const { data: versions, error: versionsErr } = await auth.supabase
      .from('generation_history')
      .select(
        'id, version_number, improve_direction, improve_note, user_feedback, sample_text, system_prompt, blueprint, analysis, feedback_status, edit_patches, session_id, revision_plan, used_knowledge, created_at'
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
        // ── Work Agent：本次迭代到底改了哪些段落、用户当时选的什么方案 ──
        editPatches: normalizeEditPatches(v.edit_patches).patches,
        revisePlan: normalizeRevisionPlan(v.revision_plan),
        sessionId: (v.session_id as string | null) ?? null,
        // Creator Knowledge System Phase 3：该版本生成时依据了哪些已确认知识。
        // 空数组 = 本次没参考任何知识（灵感模式/游客/无匹配单元），前端据此不渲染该区块。
        usedKnowledge: normalizeInjectedUnits(v.used_knowledge),
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

    // 先读旧状态：精确区分"重新开启迭代"（finalized→active）与普通状态保持
    const { data: before } = await auth.supabase
      .from('creative_projects')
      .select('status')
      .eq('id', projectId)
      .maybeSingle()

    const { data: project, error: updErr } = await auth.supabase
      .from('creative_projects')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', projectId)
      // 与 DELETE 一致，显式带上归属条件做纵深防御
      .eq('user_id', auth.userId)
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
      // M1：定稿是最强显式主题信号（权重 3.0）。按天幂等，允许"定稿→撤回→再定稿"
      await trackEvent(auth.supabase, auth.userId, {
        type: 'work_finalize',
        targetType: 'project',
        targetId: projectId,
        projectId,
        payload: { final_version: project.current_version },
        dailyKey: true,
      })
    } else if (status === 'active' && before?.status === 'finalized') {
      // M1：撤回定稿 = 撤回该定稿事件的画像贡献（中性撤回，不记负分）
      await trackEvent(auth.supabase, auth.userId, {
        type: 'work_unfinalize',
        targetType: 'project',
        targetId: projectId,
        projectId,
        dailyKey: true,
      })
    }

    return NextResponse.json({ ok: true, status: project.status })
  } catch (error) {
    console.error('creative project PATCH 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

/**
 * DELETE /api/creative/projects/[projectId] —— 项目级硬删除（作品列表删除项目作品的唯一正路）
 *
 * 背景：dashboard 的本地作品 id 是 uuid，与服务端版本行 id（{projectId}::vN）不同，
 * 走 DELETE /works/{uuid} 必然 404；即便 id 正确也会撞 /works 的版本行 409 保护
 * （"项目级删除是另一条产品路径"），而该路径此前不存在 → 项目作品删不掉，
 * work_delete 埋点永远无法触发，幽灵作品永久污染兴趣画像。本接口补上这条链路：
 *   1. 仅本人可删（RLS + loadOwnedProject 显式归属校验双保险）
 *   2. 必须先删版本行再删项目——generation_history.project_id FK 是
 *      on delete set null 而非 cascade，只删项目会把版本行孤立成无主幽灵内容
 *   3. 画像撤回（CIP M1）：finalized 项目先发 work_unfinalize（scoring 按 project
 *      撤回全部 work_finalize 贡献），再对每个版本行发 work_delete（按 generation
 *      target 撤回该版本全部贡献 + 记 -0.5 弱负分）
 *   4. 删除是低频高信号行为：完成撤回后立即触发增量重建，让推荐队列尽快反映删除结果
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params
    if (!projectId || typeof projectId !== 'string') {
      return NextResponse.json({ error: '无效的项目 ID' }, { status: 400 })
    }
    const auth = await loadOwnedProject(req, projectId)
    if (!auth.ok) return auth.response

    // 先读状态与版本行 id：状态决定是否撤回 work_finalize；版本行 id 是画像撤回的目标，
    // 行删除后无 FK 约束的 target_id 事件仍可入账（与 /works 单删同机制）
    const { data: proj } = await auth.supabase
      .from('creative_projects')
      .select('status')
      .eq('id', projectId)
      .maybeSingle()
    const { data: versions, error: vErr } = await auth.supabase
      .from('generation_history')
      .select('id, topic')
      .eq('project_id', projectId)
    if (vErr) {
      console.error('查询项目版本行失败:', vErr.message)
      return NextResponse.json({ error: '删除失败' }, { status: 500 })
    }

    // 先删版本行（FK 是 set null 非 cascade，必须显式删），再删项目行
    const { error: delVErr } = await auth.supabase
      .from('generation_history')
      .delete()
      .eq('project_id', projectId)
    if (delVErr) {
      console.error('版本行硬删除失败:', delVErr.message)
      return NextResponse.json({ error: '删除失败' }, { status: 500 })
    }
    const { error: delPErr } = await auth.supabase
      .from('creative_projects')
      .delete()
      .eq('id', projectId)
      .eq('user_id', auth.userId)
    if (delPErr) {
      console.error('项目硬删除失败:', delPErr.message)
      return NextResponse.json({ error: '删除失败' }, { status: 500 })
    }

    // 画像撤回事件。行已删除、删除不可回滚，事件失败仅记日志（下次同项目重删为 404，
    // 残留贡献会在后续 build 的孤儿清理中被自然弱化，不阻塞主流程）。
    // 注意：事件不带 projectId——creator_events.project_id 有 FK（on delete set null），
    // 指向已删除项目会 23503 违规；不带它等价于"先插事件后删行、FK 自动置 null"的终态，
    // 且撤回匹配按 target_id（scoring: work_delete matchBy target / work_unfinalize
    // matchBy project 均取 target_id），不依赖 project_id 列。
    try {
      if (proj?.status === 'finalized') {
        // 撤回定稿贡献（scoring: work_unfinalize 按 project 撤回 victim work_finalize）
        await trackEvent(auth.supabase, auth.userId, {
          type: 'work_unfinalize',
          targetType: 'project',
          targetId: projectId,
          dailyKey: true,
        })
      }
      for (const v of versions ?? []) {
        // 撤回每个版本的生成贡献（scoring: work_delete 按 generation target 撤回 + 弱负分）
        await trackEvent(auth.supabase, auth.userId, {
          type: 'work_delete',
          targetType: 'generation',
          targetId: v.id,
          topicExcerpt: typeof v.topic === 'string' ? v.topic : null,
        })
      }
    } catch (eventErr) {
      console.error('画像撤回事件入账失败（删除已生效）:', eventErr)
    }

    // 删除是低频高信号行为：立即增量重建，让推荐队列尽快反映删除（fire-and-forget，
    // 在途折叠由 runBuild 步骤 0 兜底）；失败不影响删除结果
    void runBuild(auth.supabase, auth.userId, 'incremental').catch(() => {})

    return NextResponse.json({
      ok: true,
      id: projectId,
      versionsDeleted: versions?.length ?? 0,
    })
  } catch (error) {
    console.error('creative project DELETE 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
