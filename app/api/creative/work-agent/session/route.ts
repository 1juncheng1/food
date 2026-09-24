// ============================================================
// /api/creative/work-agent/session —— Work Agent 会话生命周期
//
// POST   { projectId?, baseVersionId? }  → 复用该作品下仍 active 的会话，否则新建
// GET    ?sessionId=xx                   → 取会话 + 完整对话轨迹（刷新后可续聊）
// DELETE ?sessionId=xx                   → 放弃本次会话（status='abandoned'）
//
// 为什么需要会话而不直接用「生成历史」：
//   版本表记录的是"改出了什么"，会话表记录的是"怎么商量出来的"。
//   用户中途关页面再回来，如果只有版本表，AI 就不知道上一轮提到过什么方案、
//   用户否掉了哪一项——重新聊一遍等于让对话助手失忆。
// ============================================================

import { NextResponse } from 'next/server'
import { authenticateWithToken } from '@/lib/storage'
import {
  mapMessageRow,
  mapSessionRow,
  type WorkAgentMessage,
} from '@/lib/creative/workAgent'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

interface PostBody {
  /** 登录后所属的项目 id（游客作品为 null） */
  projectId?: unknown
  /** 基底版本行 id（generation_history.id） */
  baseVersionId?: unknown
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

// DB 行 → 领域对象的映射放在 workAgent.ts，供本路由与 chat 路由共用，避免两处漂移

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) return NextResponse.json({ error: '请先登录' }, { status: 401 })
    const auth = await authenticateWithToken(token)
    if (!auth.ok) return auth.response

    const body = (await req.json().catch(() => ({}))) as PostBody
    const projectId = str(body.projectId, 100) || null
    const baseVersionId = str(body.baseVersionId, 200) || null

    // ── 复用仍处于 active 的会话（同一作品、同一基底版本）──
    if (projectId) {
      const { data: existing, error: existErr } = await auth.supabase
        .from('work_agent_sessions')
        .select('*')
        .eq('user_id', auth.userId)
        .eq('project_id', projectId)
        .eq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (existErr) {
        console.error('会话查询失败:', existErr.message)
        return NextResponse.json({ error: '会话查询失败' }, { status: 500 })
      }

      if (existing) {
        const session = mapSessionRow(existing as Record<string, unknown>)
        const { data: msgs } = await auth.supabase
          .from('work_agent_messages')
          .select('*')
          .eq('session_id', session.id)
          .order('created_at', { ascending: true })
          .limit(200)
        return NextResponse.json({
          session,
          messages: (msgs ?? []).map((m) => mapMessageRow(m as Record<string, unknown>)),
          reused: true,
        })
      }
    }

    // ── 新建会话 ──
    const { data: created, error: createErr } = await auth.supabase
      .from('work_agent_sessions')
      .insert({
        user_id: auth.userId,
        project_id: projectId,
        base_version_id: baseVersionId,
        status: 'active',
        phase: 'clarify',
        meta: { turnCount: 0 },
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single()

    if (createErr || !created) {
      console.error('会话创建失败:', createErr?.message)
      return NextResponse.json({ error: '会话创建失败' }, { status: 500 })
    }

    return NextResponse.json({ session: mapSessionRow(created as Record<string, unknown>), messages: [], reused: false })
  } catch (error) {
    console.error('work-agent session POST 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const sessionId = searchParams.get('sessionId')
    if (!sessionId) return NextResponse.json({ error: '缺少 sessionId' }, { status: 400 })

    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) return NextResponse.json({ error: '请先登录' }, { status: 401 })
    const auth = await authenticateWithToken(token)
    if (!auth.ok) return auth.response

    const { data: sessionRow, error: sErr } = await auth.supabase
      .from('work_agent_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('user_id', auth.userId)
      .maybeSingle()

    if (sErr || !sessionRow) {
      return NextResponse.json({ error: '会话不存在' }, { status: 404 })
    }

    const { data: msgs, error: mErr } = await auth.supabase
      .from('work_agent_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(200)

    if (mErr) {
      console.error('消息查询失败:', mErr.message)
      return NextResponse.json({ error: '消息查询失败' }, { status: 500 })
    }

    return NextResponse.json({
      session: mapSessionRow(sessionRow as Record<string, unknown>),
      messages: (msgs ?? []).map((m) => mapMessageRow(m as Record<string, unknown>)),
    })
  } catch (error) {
    console.error('work-agent session GET 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const sessionId = searchParams.get('sessionId')
    if (!sessionId) return NextResponse.json({ error: '缺少 sessionId' }, { status: 400 })

    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) return NextResponse.json({ error: '请先登录' }, { status: 401 })
    const auth = await authenticateWithToken(token)
    if (!auth.ok) return auth.response

    // 软删除：消息要留下来做偏好分析，用户"放弃"这个行为本身也是有价值的负例信号
    const { error } = await auth.supabase
      .from('work_agent_sessions')
      .update({ status: 'abandoned', phase: 'done', updated_at: new Date().toISOString() })
      .eq('id', sessionId)
      .eq('user_id', auth.userId)

    if (error) {
      console.error('会话放弃失败:', error.message)
      return NextResponse.json({ error: '操作失败' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('work-agent session DELETE 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
