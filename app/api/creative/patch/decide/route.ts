import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import {
  applyPatches,
  summarizePatches,
  validatePatches,
  type ModificationPatch,
} from '@/lib/creative/patchEngine'
import { normalizeFeedbackAnalysis } from '@/lib/creative/workAgent'
import {
  applyMemoryEvent,
  parseEditingProfile,
  type EditingProfileState,
} from '@/lib/creative/editingMemory'

export const maxDuration = 20
export const dynamic = 'force-dynamic'

/**
 * POST /api/creative/patch/decide
 * AI 协作修改系统：用户对补丁建议做决策（接受 / 拒绝）。
 *
 * accept：服务端确定性融合（零 LLM 调用）→ 插入新版本行（append-only）
 *         → 更新 style_profiles.editing_profile 编辑记忆
 * reject：仅更新编辑记忆（反馈行已由 analyze-feedback 落库，不重复插入）
 *
 * 安全设计：
 *   - 融合基底 = 服务端 sample_text（不信任客户端 content）
 *   - patches 落库前二次锚点校验，0 条有效 → 400
 *   - 版本行归属 user_id 校验；老作品（无 project_id）自动建项目纳入
 *   - 版本号并发：主键冲突重查一次
 */

interface DecideBody {
  generationId?: unknown // 基底版本行 id（generation_history.id）
  accepted?: unknown // true=接受补丁 / false=拒绝
  patches?: unknown // ModificationPatch[]（patch 端点返回的原样传回）
  freeText?: unknown // 用户反馈原文（记忆事件溯源用）
  analysis?: unknown // FeedbackAnalysis（记忆事件语义来源）
  summary?: unknown // AI 补丁摘要（improve_note 用）
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function sanitizePatches(raw: unknown): ModificationPatch[] {
  if (!Array.isArray(raw)) return []
  const out: ModificationPatch[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const p = item as Record<string, unknown>
    out.push({
      segmentIndex: Number(p.segmentIndex ?? p.segment_index),
      segmentExcerpt: str(p.segmentExcerpt ?? p.segment_excerpt, 60),
      originalExcerpt: str(p.originalExcerpt ?? p.original_excerpt, 2000),
      revisedText: str(p.revisedText ?? p.revised_text, 8000),
      reason: str(p.reason, 200),
    })
    if (out.length >= 5) break
  }
  return out
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
      return NextResponse.json({ error: '登录已过期' }, { status: 401 })
    }

    const body = (await req.json().catch(() => ({}))) as DecideBody
    const generationId = str(body.generationId, 200)
    const accepted = body.accepted === true
    const freeText = str(body.freeText, 2000)
    if (!generationId) return NextResponse.json({ error: '缺少版本标识' }, { status: 400 })

    const analysis = normalizeFeedbackAnalysis(body.analysis)

    // ── 查基底版本行（RLS + 显式归属双校验）──
    const { data: row, error: rowErr } = await supabase
      .from('generation_history')
      .select(
        'id, user_id, project_id, version_number, topic, identity_label, style, category, system_prompt, sample_text, blueprint'
      )
      .eq('id', generationId)
      .maybeSingle()
    if (rowErr || !row) {
      return NextResponse.json({ error: '作品版本不存在' }, { status: 404 })
    }
    if (row.user_id !== user.id) {
      return NextResponse.json({ error: '无权修改该作品' }, { status: 403 })
    }

    // ── 编辑记忆事件 ──
    // reject 立即记录；accept 必须等锚点校验通过——否则校验失败返回 400 时
    // 会把一次实际未发生的修改确认写入偏好（污染记忆数据语义）。
    const recordMemory = async (): Promise<void> => {
      const { data: profileRow } = await supabase
        .from('style_profiles')
        .select('editing_profile')
        .eq('user_id', user.id)
        .maybeSingle()
      const prevProfile: EditingProfileState = parseEditingProfile(profileRow?.editing_profile)
      const nextProfile = applyMemoryEvent(prevProfile, { accepted, freeText, analysis })
      const { error: profileErr } = await supabase.from('style_profiles').upsert(
        { user_id: user.id, editing_profile: nextProfile },
        { onConflict: 'user_id' }
      )
      if (profileErr) {
        // 记忆更新失败不阻塞版本落库，但要有日志（degraded：本事件丢失）
        console.error('decide：编辑记忆更新失败:', profileErr)
      }
    }

    if (!accepted) {
      await recordMemory()
      return NextResponse.json({ ok: true, rejected: true })
    }

    // ── accept：服务端融合（基底以库内 sample_text 为准）──
    const baseContent = typeof row.sample_text === 'string' ? row.sample_text : ''
    if (!baseContent) {
      return NextResponse.json({ error: '作品内容为空，无法融合' }, { status: 400 })
    }
    const patches = sanitizePatches(body.patches)
    const { valid } = validatePatches(baseContent, patches)
    if (valid.length === 0) {
      return NextResponse.json(
        { error: '修改锚点校验失败，请重新生成修改建议' },
        { status: 400 }
      )
    }
    await recordMemory() // 校验通过，事件此刻才真实成立
    const mergedContent = applyPatches(baseContent, valid)

    // ── 项目归属：老作品（无 project_id）自动建项目纳入 ──
    let pid = typeof row.project_id === 'string' ? row.project_id : ''
    if (!pid) {
      const title = str(row.topic, 200) || '未命名作品'
      const { data: newProject, error: projectErr } = await supabase
        .from('creative_projects')
        .insert({ user_id: user.id, title, topic: title, status: 'active', current_version: 1 })
        .select('id')
        .single()
      if (projectErr || !newProject) {
        console.error('decide：项目创建失败:', projectErr)
        return NextResponse.json({ error: '落库失败，请稍后重试' }, { status: 500 })
      }
      pid = newProject.id as string
    }

    // ── 计算新版本号（并发安全：主键冲突重查一次）──
    const insertVersion = async (): Promise<{ vn: number; err: unknown | null }> => {
      const { data: maxRow, error: maxErr } = await supabase
        .from('generation_history')
        .select('version_number')
        .eq('project_id', pid)
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (maxErr) return { vn: 0, err: maxErr }
      const vn = (Number(maxRow?.version_number ?? 0) || 0) + 1
      const { error: insertErr } = await supabase.from('generation_history').insert({
        id: `${pid}::v${vn}`,
        user_id: user.id,
        project_id: pid,
        version_number: vn,
        topic: row.topic,
        identity_label: row.identity_label ?? null,
        style: row.style ?? null,
        category: row.category ?? null,
        system_prompt: row.system_prompt ?? null,
        sample_text: mergedContent,
        feedback_status: null,
        blueprint: row.blueprint ?? null,
        analysis: null,
        improve_direction: analysis?.intentType ?? null,
        improve_note: str(body.summary, 300) || summarizePatches(valid),
        user_feedback: freeText || null,
        edit_patches: valid,
      })
      return { vn, err: insertErr ?? null }
    }

    let { vn, err: insertErr } = await insertVersion()
    if (insertErr && (insertErr as { code?: string }).code === '23505') {
      // 并发：另一标签页刚插入过 → 重查版本号再试一次
      const retry = await insertVersion()
      vn = retry.vn
      insertErr = retry.err
    }
    if (insertErr || !vn) {
      console.error('decide：版本行写入失败:', insertErr)
      return NextResponse.json({ error: '落库失败，请稍后重试' }, { status: 500 })
    }

    // ── 更新项目当前版本 ──
    await supabase
      .from('creative_projects')
      .update({ current_version: vn, updated_at: new Date().toISOString() })
      .eq('id', pid)

    return NextResponse.json({
      ok: true,
      accepted: true,
      projectId: pid,
      versionId: `${pid}::v${vn}`,
      versionNumber: vn,
      mergedContent,
    })
  } catch (e) {
    console.error('decide 路由异常:', e)
    return NextResponse.json({ error: '处理失败，请重试' }, { status: 500 })
  }
}
