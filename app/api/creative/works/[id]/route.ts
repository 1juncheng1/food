// ============================================================
// DELETE /api/creative/works/[id] —— 作品硬删除（Creator Interest Profile M0）
//
// 背景：此前 Dashboard 删作品只删 localStorage，generation_history 行永久残留，
// 导致兴趣画像被"幽灵作品"永久污染。本接口提供服务端硬删除：
//   1. 仅本人可删（RLS 兜底 + 显式归属校验双保险）
//   2. 属于 creative_projects 的版本行禁止单独删除——版本链必须完整，
//      项目级删除/管理是另一条产品路径（避免 V2 被删后 V3 悬空）
//   3. generation_feedback 经 FK on delete cascade 自动级联清理
//
// M0：作品硬删除能力；M1：删除成功后补发 work_delete 事件（撤回画像贡献 + 弱负分）。
// ============================================================

import { NextResponse } from 'next/server'
import { authFailureResponse } from '@/lib/apiAuth'
import { createServerClient } from '@/lib/supabaseServer'
import { trackEvent } from '@/lib/creative/interest/eventTracker'
import { runBuild } from '@/lib/creative/interest/builder'
import { afterResponse } from '@/lib/afterResponse'
import { parseVectorColumn } from '@/lib/creative/interest/vectorMath'

// 后台增量重建（20–150s）挂在响应之后执行，需要实例存活窗口兜底
export const maxDuration = 60
export const dynamic = 'force-dynamic'

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    // generation_history 主键为 text（版本行形如 `${projectId}::v${N}`，已由客户端编码）
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: '无效的作品 ID' }, { status: 400 })
    }

    // ── 鉴权 ──
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
    const userId = user.id

    // ── 查行：不存在 / 他人作品（RLS 下同样查不到）一律 404，不暴露存在性 ──
    const { data: row, error: queryErr } = await supabase
      .from('generation_history')
      .select('id, user_id, project_id, topic, embedding')
      .eq('id', id)
      .maybeSingle()

    if (queryErr) {
      console.error('查询待删作品失败:', queryErr.message)
      return NextResponse.json({ error: '删除失败' }, { status: 500 })
    }
    if (!row) {
      return NextResponse.json({ error: '作品不存在或已删除' }, { status: 404 })
    }

    // ── 项目版本行保护：版本链完整，不允许从作品列表抽掉单版本 ──
    if (row.project_id) {
      return NextResponse.json(
        { error: '该作品属于创作项目，请在项目内管理版本' },
        { status: 409 }
      )
    }

    // ── 硬删除（generation_feedback 由 FK cascade 自动清理）──
    const { error: delErr } = await supabase
      .from('generation_history')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)

    if (delErr) {
      console.error('作品硬删除失败:', delErr.message)
      return NextResponse.json({ error: '删除失败' }, { status: 500 })
    }

    // M1：work_delete 事实事件——M2 评分时撤回该 target 全部贡献并记弱负分（-0.5）。
    // 能进到这里的都是无项目独立作品；target_id 是文本无 FK，作品行删除后事件仍可入账。
    await trackEvent(supabase, userId, {
      type: 'work_delete',
      targetType: 'generation',
      targetId: id,
      topicExcerpt: typeof row.topic === 'string' ? row.topic : null,
      // 带上作品向量：scoreClusters 的负事件按"最近质心"归属，无向量的删除事件
      // 会被整段跳过 —— 那样 -0.5 弱负分等于没生效，删除只剩"撤回"没有"惩罚"。
      // 行马上要被删，必须在这里把向量读出来。
      embedding: parseVectorColumn(row.embedding),
    })

    // 删除是低频高信号行为：立即增量重建让推荐队列尽快反映删除。
    // 走 afterResponse 而非 void：serverless 下响应一发出进程即可能被冻结，
    // 20–150s 的 build 会跑不完就死（"删了作品推荐不变"的静默根因之一）。
    // 在途折叠仍由 runBuild 步骤 0 兜底；失败不影响删除结果。
    afterResponse(() => runBuild(supabase, userId, 'incremental').catch(() => {}))

    return NextResponse.json({ ok: true, id })
  } catch (error) {
    console.error('creative works DELETE 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
