import { NextResponse } from 'next/server'
import { authFailureResponse } from '@/lib/apiAuth'
import { createServerClient } from '@/lib/supabaseServer'

// ============================================================
// GET /api/creative/projects —— 作品成长档案列表
//
// 只做一件事：把「我的作品」从文件列表升级成成长档案。
// 返回每个项目的版本数、修改次数（V2+）、反馈条数、诊断次数与版本时间线，
// 供 /works 展示"这篇作品是怎么长出来的"。
//
// 只读接口，不写任何表；鉴权 + RLS 双保险，只返回本人项目。
// ============================================================

export const maxDuration = 20
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
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

  // 项目行：显式 user_id 过滤（不依赖 RLS 兜底）
  const { data: projects, error: projectsErr } = await supabase
    .from('creative_projects')
    .select('id, title, topic, status, current_version, created_at, updated_at')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(50)

  if (projectsErr) {
    console.error('查询创作项目列表失败:', projectsErr)
    return NextResponse.json({ error: '查询失败' }, { status: 500 })
  }

  const list = projects ?? []
  if (list.length === 0) {
    return NextResponse.json({ projects: [] })
  }

  // 版本行：只取归档需要的轻量字段，不取 sample_text（正文可能很长）
  const { data: versions, error: versionsErr } = await supabase
    .from('generation_history')
    .select(
      'id, project_id, version_number, user_feedback, feedback_status, analysis, improve_direction, created_at'
    )
    .eq('user_id', user.id)
    .in('project_id', list.map((p) => p.id))
    .order('version_number', { ascending: true })

  if (versionsErr) {
    console.error('查询版本归档失败:', versionsErr)
    return NextResponse.json({ error: '查询版本失败' }, { status: 500 })
  }

  const rows = versions ?? []
  const byProject = new Map<string, typeof rows>()
  for (const v of rows) {
    const key = v.project_id as string
    const arr = byProject.get(key) ?? []
    arr.push(v)
    byProject.set(key, arr)
  }

  const items = list.map((p) => {
    const vs = byProject.get(p.id as string) ?? []
    const feedbackCount = vs.filter(
      (v) => typeof v.user_feedback === 'string' && v.user_feedback.trim()
    ).length
    const diagnosedCount = vs.filter((v) => v.analysis != null).length
    return {
      id: p.id as string,
      title: (p.title as string | null) ?? (p.topic as string | null) ?? '未命名作品',
      topic: (p.topic as string | null) ?? '',
      status: (p.status as string | null) ?? 'draft',
      currentVersion: (p.current_version as number | null) ?? vs.length ?? 1,
      createdAt: p.created_at as string,
      updatedAt: p.updated_at as string,
      versionCount: vs.length,
      /** 修改次数：V2 及以后每个版本都是一次迭代 */
      revisionCount: Math.max(0, vs.length - 1),
      feedbackCount,
      diagnosedCount,
      liked: vs.some((v) => v.feedback_status === 'like'),
      versions: vs.map((v) => ({
        /** 版本行 id：详情页 /article/{id} 用它定位，不是项目 id */
        id: v.id as string,
        versionNumber: v.version_number as number,
        createdAt: v.created_at as string,
        userFeedback:
          typeof v.user_feedback === 'string' && v.user_feedback.trim()
            ? v.user_feedback
            : null,
        improveDirection:
          typeof v.improve_direction === 'string' ? v.improve_direction : null,
      })),
    }
  })

  return NextResponse.json({
    projects: items,
    // 汇总：让页面顶部能呈现"积累"本身
    summary: {
      workCount: items.length,
      versionCount: rows.length,
      revisionCount: items.reduce((s, i) => s + i.revisionCount, 0),
      feedbackCount: items.reduce((s, i) => s + i.feedbackCount, 0),
    },
  })
}
