// ============================================================
// POST /api/creative/knowledge/build
// 跨素材 claims → 知识单元候选，写入 creator_knowledge
//
// 鉴权：Bearer token；限流：3 次/10 分钟（单次含 1 次 LLM 归纳，同 interest-build 口径）
//
// ⚠ 核心约束：永不覆盖用户已确认过的单元。
// 重建只做两件事 —— 引入新候选、给既有候选补来源。用户确认过的命题属于授权过的知识，
// 被一次后台重建静默改写会让「确认」这个动作失去意义。
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { authFailureResponse } from '@/lib/apiAuth'
import { rateLimit } from '@/lib/rateLimit'
import { normalizeKnowledgeItem } from '@/lib/creative/knowledgeItem'
import {
  buildCandidateUnits,
  type ClaimRef,
} from '@/lib/creative/knowledgeAggregator'
import {
  isKnowledgeStatus,
  type KnowledgeStatus,
} from '@/lib/creative/knowledgeUnit'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

/** 单次参与聚合的素材上限：控制 LLM prompt 体积 */
const MAX_MATERIALS = 300

export async function POST(req: Request) {
  // ── 鉴权 ──
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

  // ── 限流 ──
  const rl = rateLimit(`knowledge-build:${userId}`, 3, 10 * 60_000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: `操作过于频繁，请 ${rl.retryAfterSec} 秒后再试` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    )
  }

  // ── 取已 AI 理解过的素材 ──
  // knowledge IS NOT NULL：没有 AI 理解的素材不会有 claims
  const { data: rows, error: fetchErr } = await supabase
    .from('scripts')
    .select('id, knowledge')
    .eq('user_id', userId)
    .not('knowledge', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(MAX_MATERIALS)

  if (fetchErr) {
    console.error('knowledge-build: 素材查询失败:', fetchErr.message)
    return NextResponse.json({ error: '素材查询失败' }, { status: 500 })
  }

  // ── 摊平成 claims 引用列表 ──
  const refs: ClaimRef[] = []
  for (const row of (rows ?? []) as Array<{ id: string; knowledge: unknown }>) {
    const item = normalizeKnowledgeItem(row.knowledge)
    if (!item?.claims?.length) continue
    for (const c of item.claims) {
      refs.push({ itemId: row.id, claim: c })
    }
  }

  if (refs.length === 0) {
    return NextResponse.json({
      group_count: 0,
      unit_count: 0,
      inserted: 0,
      updated: 0,
      skipped_confirmed: 0,
      degraded: false,
      hint: '尚未积累足以跨素材归纳的主张（知识单元至少需来自 2 条不同素材）',
    })
  }

  // ── 归纳 ──
  const { units, degraded, groupCount } = await buildCandidateUnits(refs)
  if (units.length === 0) {
    return NextResponse.json({
      group_count: groupCount,
      unit_count: 0,
      inserted: 0,
      updated: 0,
      skipped_confirmed: 0,
      degraded,
    })
  }

  // ── 读既有单元（用于增量合并而非重复插入）──
  const { data: existingRows } = await supabase
    .from('creator_knowledge')
    .select('id, concept, kind, status, source_item_ids')

  // 只需区分状态与来源，不必构造完整单元对象
  const existingByKey = new Map<
    string,
    { id: string; status: KnowledgeStatus; sourceItemIds: string[] }
  >()
  for (const r of (existingRows ?? []) as Array<Record<string, unknown>>) {
    const concept = String(r.concept ?? '')
    const kind = String(r.kind ?? '')
    existingByKey.set(`${concept}|${kind}`, {
      id: String(r.id),
      status: isKnowledgeStatus(r.status) ? r.status : '候选',
      sourceItemIds: Array.isArray(r.source_item_ids) ? (r.source_item_ids as string[]) : [],
    })
  }

  const toInsert: Array<Record<string, unknown>> = []
  const toUpdate: Array<{ id: string; payload: Record<string, unknown> }> = []
  let skippedConfirmed = 0

  const now = new Date().toISOString()

  for (const u of units) {
    const key = `${u.concept}|${u.kind}`
    const hit = existingByKey.get(key)

    if (!hit) {
      toInsert.push({
        user_id: userId,
        concept: u.concept,
        claim: u.claim,
        kind: u.kind,
        domain_scope: u.domainScope,
        confidence: u.confidence,
        source_item_ids: u.sourceItemIds,
        source_count: u.sourceItemIds.length,
        // 默认候选：未经用户确认不进注入
        status: '候选',
        updated_at: now,
      })
      continue
    }

    // 已确认 / 已拒绝：不动命题，只补来源证据（旁证越多越稳）
    if (hit.status === '已确认' || hit.status === '已拒绝') {
      skippedConfirmed++
      const merged = Array.from(
        new Set([...hit.sourceItemIds, ...u.sourceItemIds])
      )
      if (merged.length === hit.sourceItemIds.length) continue
      toUpdate.push({
        id: hit.id,
        payload: {
          source_item_ids: merged,
          source_count: merged.length,
          updated_at: now,
        },
      })
      continue
    }

    // 候选 / 已过期：可以刷新归纳结果
    const merged = Array.from(new Set([...hit.sourceItemIds, ...u.sourceItemIds]))
    toUpdate.push({
      id: hit.id,
      payload: {
        claim: u.claim,
        confidence: u.confidence,
        domain_scope: u.domainScope,
        source_item_ids: merged,
        source_count: merged.length,
        updated_at: now,
      },
    })
  }

  // ── 落库 ──
  let inserted = 0
  let updated = 0

  if (toInsert.length > 0) {
    const { error: insErr } = await supabase.from('creator_knowledge').insert(toInsert)
    if (insErr) {
      console.error('knowledge-build: 候选写入失败:', insErr.message)
      return NextResponse.json({ error: '知识单元写入失败' }, { status: 500 })
    }
    inserted = toInsert.length
  }

  if (toUpdate.length > 0) {
    const results = await Promise.all(
      toUpdate.map((it) =>
        supabase
          .from('creator_knowledge')
          .update(it.payload)
          .eq('id', it.id)
          .eq('user_id', userId)
      )
    )
    updated = results.filter((r) => !r.error).length
  }

  return NextResponse.json({
    group_count: groupCount,
    unit_count: units.length,
    inserted,
    updated,
    skipped_confirmed: skippedConfirmed,
    degraded,
  })
}
