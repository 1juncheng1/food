// ============================================================
// Creator Interest Profile —— 候选生成 + 硬过滤
// S1/S3/S5 取数 + hardFilter 纯函数；S2/S4 在 synthesizer 做
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { cosineSimilarity } from './vectorMath'

export interface Candidate {
  source: 'own_inspiration' | 'ci_market' | 'saved_material' | 'exploration' | 'active_project'
  slot: 'core_gap' | 'evidence_followup' | 'exploration' | 'continuation'
  title: string
  description: string
  topic: string
  formHint: string
  embedding: number[] | null
  clusterCode: string | null
  contentValue: number
  marketRefs: Array<{ platform: string; url: string }> | null
  /** 关联的项目 id（S5 用，builder 可据此直接关联簇，无需向量猜测） */
  projectId?: string | null
  /**
   * WF11 P1：跨簇探索标记。S4 产出的候选若来自两个兴趣方向的融合种子则为 true，
   * builder 透传到 suggestions.evidence.cross_exploration 供前端打"跨界灵感"标。
   */
  crossSeed?: boolean
  /**
   * WF11 P1：S4 内部字段——LLM 回射的来源种子方向名（须原样等于某个种子 label）。
   * builder 据此把单簇探索卡关联回来源簇（获得簇事实/理由覆盖）；
   * 不落库（SuggestionInsertInput 不含此字段），cross 卡即便带 label 也不绑簇。
   */
  seedLabel?: string
}

const WRITTEN_THRESHOLD = 0.85
const DISMISSED_THRESHOLD = 0.30
const QUEUE_THRESHOLD = 0.88

export function hardFilter(
  candidates: Candidate[],
  writtenEmbeddings: number[][],
  dismissedEmbeddings: number[][],
  activeQueueEmbeddings: number[][],
  threshold?: { written?: number; dismissed?: number; queue?: number }
): Candidate[] {
  const wt = threshold?.written ?? WRITTEN_THRESHOLD
  const dt = threshold?.dismissed ?? DISMISSED_THRESHOLD
  const qt = threshold?.queue ?? QUEUE_THRESHOLD

  return candidates.filter((c) => {
    if (!c.embedding) return true // 无向量不做相似度过滤
    for (const we of writtenEmbeddings) {
      if (cosineSimilarity(c.embedding, we) > wt) return false
    }
    for (const de of dismissedEmbeddings) {
      if (cosineSimilarity(c.embedding, de) > (1 - dt)) return false
    }
    for (const qe of activeQueueEmbeddings) {
      if (cosineSimilarity(c.embedding, qe) > qt) return false
    }
    return true
  })
}

// ── S1: 未兑现的灵感分析 ──
export async function getOwnInspirationCandidates(
  supabase: SupabaseClient,
  userId: string
): Promise<Candidate[]> {
  const { data: events } = await supabase
    .from('creator_events')
    .select('id, target_id, payload, embedding, cluster_id, occurred_at')
    .eq('user_id', userId)
    .eq('event_type', 'inspiration_analyze')
    .order('occurred_at', { ascending: false })
    .limit(20)

  if (!events?.length) return []

  const out: Candidate[] = []
  for (const e of events) {
    const payload = e.payload as Record<string, unknown> | null
    const topic = (payload?.topic_excerpt as string) || (payload?.topic as string) || ''
    const overallScore = (payload?.overall_score as number) ?? 5
    const competitionLevel = (payload?.competition_level as number) ?? 5

    // 查后续 30 天有无同簇 work_generate
    if (e.cluster_id) {
      const { count } = await supabase
        .from('creator_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('event_type', 'work_generate')
        .eq('cluster_id', e.cluster_id)
        .gte('occurred_at', e.occurred_at as string)
      if (count && count > 0) continue // 已兑现
    }

    out.push({
      source: 'own_inspiration',
      slot: 'evidence_followup',
      title: topic.slice(0, 40) || '之前的灵感主题',
      description: `你分析过这个主题，价值分 ${overallScore}/10，竞争度 ${competitionLevel}`,
      topic,
      formHint: '其他',
      embedding: Array.isArray(e.embedding) ? (e.embedding as number[]) : null,
      clusterCode: null,
      contentValue: overallScore / 10,
      marketRefs: null,
    })
  }
  return out.slice(0, 3)
}

// ── S3: 沉淀未用的素材 ──
export async function getSavedMaterialCandidates(
  supabase: SupabaseClient,
  userId: string
): Promise<Candidate[]> {
  const { data: materials } = await supabase
    .from('creator_events')
    .select('id, target_id, payload, embedding, cluster_id, occurred_at')
    .eq('user_id', userId)
    .eq('event_type', 'material_save')
    .order('occurred_at', { ascending: false })
    .limit(20)

  if (!materials?.length) return []

  const out: Candidate[] = []
  for (const m of materials) {
    const payload = m.payload as Record<string, unknown> | null
    const topic = (payload?.topic_excerpt as string) || ''
    const sixtyDaysAgo = new Date()
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)

    // 查近 60 天有无同簇 work_generate
    if (m.cluster_id) {
      const { count } = await supabase
        .from('creator_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('event_type', 'work_generate')
        .eq('cluster_id', m.cluster_id)
        .gte('occurred_at', sixtyDaysAgo.toISOString())
      if (count && count > 0) continue // 已用
    }

    out.push({
      source: 'saved_material',
      slot: 'evidence_followup',
      title: topic.slice(0, 40) || '已保存的素材',
      description: `你为这个方向攒过素材，但还没写出来`,
      topic,
      formHint: '其他',
      embedding: Array.isArray(m.embedding) ? (m.embedding as number[]) : null,
      clusterCode: null,
      contentValue: 0.55,
      marketRefs: null,
    })
  }
  return out.slice(0, 2)
}

// ── S5: 当前创作目标延续 ──
export async function getActiveProjectCandidates(
  supabase: SupabaseClient,
  userId: string
): Promise<Candidate[]> {
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const { data: projects } = await supabase
    .from('creative_projects')
    .select('id, title, topic, current_version, updated_at')
    .eq('user_id', userId)
    .eq('status', 'active')
    .gte('updated_at', sevenDaysAgo.toISOString())
    .order('updated_at', { ascending: false })
    .limit(1)

  if (!projects?.length) return []

  const out: Candidate[] = []
  for (const p of projects) {
    const vId = `${p.id}::v${p.current_version}`
    const { data: gen } = await supabase
      .from('generation_history')
      .select('analysis, topic, embedding')
      .eq('id', vId)
      .maybeSingle()

    const projectTitle = (p.title as string) || '进行中的项目'
    // 灵感页要的是"新角度"，不是旧稿修改建议（那是编辑器/dashboard 的职责）。
    // 只做中性的延续引导，具体选题交给生成流程。
    const desc = `「${projectTitle}」还在进行中，可以换个新角度继续写`
    out.push({
      source: 'active_project',
      slot: 'continuation',
      title: projectTitle.slice(0, 40),
      description: desc.slice(0, 120),
      topic: (p.topic as string) || projectTitle,
      formHint: '其他',
      embedding: Array.isArray(gen?.embedding) ? (gen!.embedding as number[]) : null,
      clusterCode: null,
      contentValue: 0.65,
      marketRefs: null,
      projectId: p.id as string,
    })
  }
  return out
}
