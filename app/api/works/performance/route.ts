import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'

export const dynamic = 'force-dynamic'

// ============================================================
// 作品发布表现回流 API（轻量版：手动三档自评）
//
// 与 /api/feedback（👍/👎 生成质量反馈）是两个不同信号：
//   - feedback_status：作品生成得好不好（站内质量）
//   - performance_feedback：发布到平台后表现如何（市场验证）
// 数据落 generation_history.performance_feedback jsonb，覆盖式更新（最新自评为准）。
//
// 权限：用户 token + RLS（generation_history UPDATE 策略 = 仅本人行），
// 更新 .select('id') 以确认命中行数——0 行 = 记录不存在或非本人作品。
// ============================================================

const VALID_GRADES = ['good', 'okay', 'flop'] as const
type Grade = (typeof VALID_GRADES)[number]

const VALID_PLATFORMS = ['wechat', 'xhs', 'douyin', 'bilibili', 'zhihu', 'other'] as const
type Platform = (typeof VALID_PLATFORMS)[number]

interface PerformanceBody {
  generationId?: unknown
  grade?: unknown
  platform?: unknown
  note?: unknown
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

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

// ── GET：恢复已记录的表现（页面刷新后回显用）──
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

    const { data, error } = await auth.supabase
      .from('generation_history')
      .select('performance_feedback')
      .eq('id', genId)
      .maybeSingle()

    if (error || !data) {
      return NextResponse.json({ performance: null })
    }

    const fb = data.performance_feedback
    return NextResponse.json({
      performance:
        fb && typeof fb === 'object' && typeof (fb as Record<string, unknown>).grade === 'string'
          ? fb
          : null,
    })
  } catch (error) {
    console.error('performance GET 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

// ── POST：记录/更新发布表现（覆盖式）──
export async function POST(req: Request) {
  try {
    let body: PerformanceBody
    try {
      body = (await req.json()) as PerformanceBody
    } catch {
      return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
    }

    const auth = await authenticate(req)
    if (!auth) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }

    // 入参校验（快速失败）
    const generationId = str(body.generationId, 100)
    if (!generationId) {
      return NextResponse.json({ error: '缺少作品标识' }, { status: 400 })
    }
    const grade = body.grade as Grade
    if (!VALID_GRADES.includes(grade)) {
      return NextResponse.json({ error: '无效的表现档位' }, { status: 400 })
    }
    const platformRaw = str(body.platform, 20)
    const platform: Platform | null =
      platformRaw && (VALID_PLATFORMS as readonly string[]).includes(platformRaw)
        ? (platformRaw as Platform)
        : null
    const note = str(body.note, 200) || null

    const performance = {
      grade,
      platform,
      note,
      recorded_at: new Date().toISOString(),
    }

    // 覆盖式更新；.select('id') 确认命中（0 行 = 记录不存在或非本人，RLS 拦截）
    const { data, error } = await auth.supabase
      .from('generation_history')
      .update({ performance_feedback: performance })
      .eq('id', generationId)
      .select('id')

    if (error) {
      console.error('performance POST 更新失败:', error)
      // 服务端日志保留细节；数据库报错可能含表名/策略名，不能回显给客户端
      return NextResponse.json({ error: '记录失败' }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: '作品记录不存在或已失效' }, { status: 404 })
    }

    return NextResponse.json({ ok: true, performance })
  } catch (error) {
    console.error('performance POST 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
