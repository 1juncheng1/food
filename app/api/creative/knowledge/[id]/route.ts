// ============================================================
// PATCH /api/creative/knowledge/[id]
// 用户对单条知识单元做确认 / 拒绝 / 修正
// body: { status?, claim?, domainScope?, confidence? }（至少一个字段）
//
// ⚠ 这是「候选 → 已确认」的唯一写入口。AI 侧（build）永远只写候选，
// 确认只能由用户操作 —— 否则「用户授权」这道闸门形同虚设。
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import {
  isKnowledgeStatus,
  normalizeKnowledgeUnit,
} from '@/lib/creative/knowledgeUnit'

export const dynamic = 'force-dynamic'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!id || !UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: '无效的知识单元 ID' }, { status: 400 })
  }

  const token = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }
  const supabase = createServerClient(token)
  const { data: userData, error: authErr } = await supabase.auth.getUser()
  if (authErr || !userData.user) {
    return authFailureResponse(authErr)
  }
  const userId = userData.user.id

  const body = await req.json().catch(() => ({}))
  const { status, claim, domainScope, confidence } = body ?? {}

  if (
    status === undefined &&
    claim === undefined &&
    domainScope === undefined &&
    confidence === undefined
  ) {
    return NextResponse.json({ error: '请提供要修改的字段' }, { status: 400 })
  }

  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }

  if (status !== undefined) {
    if (!isKnowledgeStatus(status)) {
      return NextResponse.json({ error: '无效的 status' }, { status: 400 })
    }
    payload.status = status
    // 确认时间随状态走：回到候选时要清掉，避免"曾经确认过"的残留证据
    payload.confirmed_at = status === '已确认' ? new Date().toISOString() : null
  }

  if (claim !== undefined) {
    const text = typeof claim === 'string' ? claim.trim().slice(0, 400) : ''
    if (!text) {
      return NextResponse.json({ error: 'claim 不能为空' }, { status: 400 })
    }
    payload.claim = text
  }

  if (domainScope !== undefined) {
    payload.domain_scope = Array.isArray(domainScope)
      ? Array.from(
          new Set(
            domainScope
              .filter((v): v is string => typeof v === 'string')
              .map((v) => v.trim().slice(0, 40))
              .filter(Boolean)
          )
        ).slice(0, 5)
      : []
  }

  if (confidence !== undefined) {
    const n = typeof confidence === 'number' ? confidence : parseFloat(String(confidence))
    if (isNaN(n)) {
      return NextResponse.json({ error: 'confidence 必须是数字' }, { status: 400 })
    }
    payload.confidence = Math.max(0, Math.min(1, n))
  }

  // 显式带上 user_id：RLS 已限制，这里再加一道，防止越权更新静默成功
  const { data, error } = await supabase
    .from('creator_knowledge')
    .update(payload)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle()

  if (error) {
    if ((error as { code?: string }).code === '42P01') {
      return NextResponse.json(
        {
          error: '知识单元表尚未初始化，请先执行 supabase/migrations/0005_creator_knowledge.sql',
          needsMigration: true,
        },
        { status: 503 }
      )
    }
    console.error('knowledge-patch: 更新失败:', error.message)
    return NextResponse.json({ error: '更新失败' }, { status: 500 })
  }

  if (!data) {
    return NextResponse.json({ error: '知识单元不存在' }, { status: 404 })
  }

  return NextResponse.json({ unit: normalizeKnowledgeUnit(data) })
}
