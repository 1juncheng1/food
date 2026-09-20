// ============================================================
// Creator Interest Profile —— 推荐卡队列读写 + 状态流转
//
// interest_suggestions 表的薄封装：
//   读：getActiveSuggestions（推荐接口用，按 score 倒序取 N）
//   写：insertSuggestions（builder 13-14 步落库）
//   状态流转：markConsumed / markDismissed / markImpressed（用户行为回流）
//   生命周期：supersedeOldBuild / expireOld
//
// 状态机：active → impressed → consumed/dismissed → expired/superseded
//   active     仍可展示（默认）
//   impressed  本次请求展示给用户过（一次曝光一次标记，限流避免反复改）
//   consumed   用户点击进入创作（rec_id 透传到 /generate 后回流）
//   dismissed  用户明确点 ✕（不计入负权重，但不再展示）
//   expired    超过 14 天未消费
//   superseded 新 build 落库后旧 active 全置此（避免推荐陈旧候选）
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface SuggestionRow {
  id: string
  cluster_code: string
  slot: string
  source: string
  title: string
  description: string
  topic: string
  form_hint: string
  score: number
  score_breakdown: Record<string, number> | null
  evidence: Record<string, unknown> | null
  market_refs: Record<string, unknown> | null
  // WF6：AI 预制推荐理由（旧卡/模板卡为 null + 'template'）
  core_question: string | null
  why_recommend: string | null
  creation_angle: string | null
  related_knowledge: string[] | null
  reason_source: string | null
}

/** builder 落库前的输入结构 */
export interface SuggestionInsertInput {
  clusterCode: string
  slot: 'core_gap' | 'evidence_followup' | 'exploration' | 'continuation'
  source: 'own_inspiration' | 'ci_market' | 'saved_material' | 'exploration' | 'active_project'
  title: string
  description: string
  topic: string
  formHint: string
  score: number
  scoreBreakdown: Record<string, number>
  evidence: Record<string, unknown>
  marketRefs?: Record<string, unknown> | null
  // WF6：AI 理由（可选；未提供时落 template 默认）
  coreQuestion?: string | null
  whyRecommend?: string | null
  creationAngle?: string | null
  relatedKnowledge?: string[] | null
  reasonSource?: 'ai' | 'template' | null
}

// ── 读 ──

/**
 * 读取 active 推荐卡（按 score 倒序）。
 * 推荐接口用，limit 一般 = 6（selectSlots 再分槽选 3 张）。
 */
export async function getActiveSuggestions(
  supabase: SupabaseClient,
  userId: string,
  limit = 6
): Promise<SuggestionRow[]> {
  const { data, error } = await supabase
    .from('interest_suggestions')
    .select('id, cluster_code, slot, source, title, description, topic, form_hint, score, score_breakdown, evidence, market_refs, core_question, why_recommend, creation_angle, related_knowledge, reason_source')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('score', { ascending: false })
    .limit(limit)
  if (error) {
    console.error('[interest] 读 active 推荐卡失败:', error)
    return []
  }
  return (data ?? []) as unknown as SuggestionRow[]
}

// ── 写 ──

/**
 * 批量落库新推荐卡。
 * 调用前应已用 supersedeOldBuild 把同用户旧 active 卡置 superseded，
 * 保证同一时刻同用户只有一批 active 卡。
 */
export async function insertSuggestions(
  supabase: SupabaseClient,
  userId: string,
  buildId: string,
  items: SuggestionInsertInput[]
): Promise<number> {
  if (!items.length) return 0

  const rows = items.map((it) => ({
    user_id: userId,
    build_id: buildId,
    cluster_code: it.clusterCode,
    slot: it.slot,
    source: it.source,
    title: it.title.slice(0, 40),
    description: it.description.slice(0, 120),
    topic: it.topic.slice(0, 200),
    form_hint: it.formHint || '其他',
    score: Math.max(0, Math.min(1, it.score)),
    score_breakdown: it.scoreBreakdown,
    evidence: it.evidence,
    market_refs: it.marketRefs ?? null,
    // WF6：AI 预制理由（AI 失败/模板卡落默认值，卡不丢）
    core_question: it.coreQuestion ?? null,
    why_recommend: it.whyRecommend ?? null,
    creation_angle: it.creationAngle ?? null,
    related_knowledge: it.relatedKnowledge ?? [],
    reason_source: it.reasonSource ?? 'template',
    status: 'active',
  }))

  const { error } = await supabase.from('interest_suggestions').insert(rows)
  if (error) {
    console.error('[interest] 落库推荐卡失败:', error)
    return 0
  }
  return rows.length
}

// ── 状态流转 ──

/**
 * 按 id + user_id 双条件读取单张推荐卡（WF1 反馈闭环前置）。
 * events 端点用来：① 校验 rec_id 归属（防越权上报）；② 取 topic 供
 * dismiss/click 补算 embedding，让行为精确落进对应兴趣簇。
 */
export async function getSuggestionById(
  supabase: SupabaseClient,
  suggestionId: string,
  userId: string
): Promise<{
  id: string
  topic: string
  title: string
  cluster_code: string | null
  slot: string | null
} | null> {
  const { data, error } = await supabase
    .from('interest_suggestions')
    .select('id, topic, title, cluster_code, slot')
    .eq('id', suggestionId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    console.error('[interest] 读取推荐卡失败:', error.message)
    return null
  }
  return (data as unknown as {
    id: string
    topic: string
    title: string
    cluster_code: string | null
    slot: string | null
  }) ?? null
}

/** 用户点击进入创作（rec_id 透传到 /generate 后回流） */
export async function markConsumed(
  supabase: SupabaseClient,
  suggestionId: string
): Promise<void> {
  await supabase
    .from('interest_suggestions')
    .update({ status: 'consumed' })
    .eq('id', suggestionId)
}

/** 用户明确点 ✕ 不感兴趣 */
export async function markDismissed(
  supabase: SupabaseClient,
  suggestionId: string
): Promise<void> {
  await supabase
    .from('interest_suggestions')
    .update({ status: 'dismissed' })
    .eq('id', suggestionId)
}

/** 本次请求展示过该卡（M5 灵感页曝光埋点调用） */
export async function markImpressed(
  supabase: SupabaseClient,
  suggestionIds: string[]
): Promise<void> {
  if (!suggestionIds.length) return
  await supabase
    .from('interest_suggestions')
    .update({ status: 'impressed' })
    .in('id', suggestionIds)
    .eq('status', 'active') // 只动 active，避免覆盖已 dismissed/consumed
}

// ── 生命周期 ──

/**
 * 新 build 落库前：把该用户旧的 active 推荐卡全部置 superseded。
 * 避免新旧两批卡同时在 active 队列里，保证推荐一致性。
 */
export async function supersedeOldBuild(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  await supabase
    .from('interest_suggestions')
    .update({ status: 'superseded' })
    .eq('user_id', userId)
    .eq('status', 'active')
}

/** 定时任务调用：过期 active/impressed 卡（默认 14 天） */
export async function expireOld(
  supabase: SupabaseClient,
  beforeDate?: Date
): Promise<number> {
  const cutoff = (beforeDate ?? new Date()).toISOString()
  const { data, error } = await supabase
    .from('interest_suggestions')
    .update({ status: 'expired' })
    .lt('expires_at', cutoff)
    .in('status', ['active', 'impressed'])
    .select('id')
  if (error) {
    console.error('[interest] 过期推荐卡失败:', error)
    return 0
  }
  return data?.length ?? 0
}
