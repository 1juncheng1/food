// ============================================================
// Creator Interest Profile —— 画像 jsonb 装配（纯函数）
//
// 第二阶段设计中的六层视图在这里落地为 interest_profile jsonb。
// 创作目的/内容偏好只放引用指针与推断增量，权威值仍读 declaration。
// ============================================================

import { ALGO_VERSION, EMBEDDING_MODEL, RULE_VERSION } from './config'
import type { EngineEvent, InterestLayer, TrendDirection } from './types'
import { needsInterpret } from './weights'
import type { CreatorDeclaration } from '../creatorDeclaration'

export interface ClusterView {
  clusterId: string
  code: string
  label: string
  summary: string
  layer: InterestLayer
  weight: number
  confidence: number
  trend: TrendDirection
  rawScore: number
  eventCount: number
  projectCount: number
  createCount: number
  finalizeCount: number
  saveCount?: number
  firstSeenAt: string
  lastSeenAt: string
  genuineRatio: number
  isNegative: boolean
  topEvidence: Array<{ event_id: string; target_id: string | null; title: string; at: string; signal: string }>
  domains: Record<string, number>
  keywords: string[]
}

export interface BuildAssemblyInput {
  buildId: string
  clusters: ClusterView[]
  events: EngineEvent[]
  firstEventAt: string
  lastEventAt: string
  /** WF3：创作者主动声明（权威来源，不 AI 推断；builder 从 style_profiles 读入） */
  declaration?: CreatorDeclaration | null
}

function layerArrays(clusters: ClusterView[]) {
  const core: ClusterView[] = []
  const exploration: ClusterView[] = []
  const temporary: ClusterView[] = []
  for (const c of clusters) {
    if (c.isNegative) continue
    if (c.layer === 'core') core.push(c)
    else if (c.layer === 'exploration') exploration.push(c)
    else temporary.push(c)
  }
  const cmp = (a: ClusterView, b: ClusterView) => b.weight - a.weight
  return {
    core: core.sort(cmp).map(toRef),
    exploration: exploration.sort(cmp).map(toRef),
    temporary: temporary.sort(cmp).map(toRef),
  }
}

function toRef(c: ClusterView) {
  return {
    cluster_id: c.clusterId,
    code: c.code,
    label: c.label,
    weight: Math.round(c.weight * 1000) / 1000,
    confidence: c.confidence,
    trend: c.trend,
  }
}

function aggregateDomains(clusters: ClusterView[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of clusters) {
    if (c.isNegative) continue
    for (const [k, v] of Object.entries(c.domains)) {
      out[k] = (out[k] ?? 0) + v * c.weight
    }
  }
  const sum = Object.values(out).reduce((s, v) => s + v, 0) || 1
  for (const k of Object.keys(out)) out[k] = Math.round((out[k] / sum) * 1000) / 1000
  return out
}

export function assembleProfile(input: BuildAssemblyInput): Record<string, unknown> {
  const { clusters, events, firstEventAt, lastEventAt, buildId, declaration } = input
  const layers = layerArrays(clusters)

  // 行为原因汇总（近 90 天）
  const recent = events.filter((e) => {
    const age = (Date.now() - Date.parse(e.occurredAt)) / 86_400_000
    return age <= 90
  })
  const reasonMix: Record<string, number> = {}
  let totalWeight = 0
  for (const e of recent) {
    if (!needsInterpret(e.type)) continue
    const w = 1
    totalWeight += w
    if (!e.interpretation?.reasons) {
      reasonMix['genuine_interest'] = (reasonMix['genuine_interest'] ?? 0) + w
      continue
    }
    for (const r of e.interpretation.reasons) {
      const p = Number(r.probability) || 0
      reasonMix[r.code] = (reasonMix[r.code] ?? 0) + p * w
    }
  }
  if (totalWeight > 0) {
    for (const k of Object.keys(reasonMix)) reasonMix[k] = Math.round((reasonMix[k] / totalWeight) * 1000) / 1000
  }

  // 事件量
  const eventCount30d = events.filter((e) => (Date.now() - Date.parse(e.occurredAt)) / 86_400_000 <= 30).length

  // 完整度：事件量 + 簇数 + 是否有 declaration（后者由 builder 补充）
  const completeness = Math.min(
    1,
    Math.round((events.length / 20 + clusters.filter((c) => !c.isNegative).length / 3) * 50) / 100
  )

  // ── WF3：四字段扩展（拒绝简单标签，理解"为什么喜欢"） ──

  // 1) topic_interest：top8 非负向簇，0-100 量纲，reason = 行为事实模板（非 LLM）
  const POSITIVE_REASONS: Record<TrendDirection, string> = {
    rising: '近期创作与互动持续升温',
    stable: '稳定的创作主题',
    declining: '近期互动减少，热度回落',
    dormant: '长期未再有相关行为',
  }
  const topicInterest = clusters
    .filter((c) => !c.isNegative)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
    .map((c) => ({
      name: c.label,
      weight: Math.round(c.weight * 100),
      reason:
        `近 90 天 ${c.eventCount} 次相关行为` +
        (c.createCount > 0 ? `，生成 ${c.createCount} 篇` : '') +
        `，${POSITIVE_REASONS[c.trend]}`,
    }))

  // 2) creative_goals：权威读 declaration.creator_goal，永不 AI 推断
  const creativeGoals = declaration?.creator_goal ? [declaration.creator_goal] : []

  // 3) content_preference：likes = core 簇 label ∪ declaration 表达类维度；
  //    dislikes = 负向簇 label ∪ avoid_preference（硬约束）
  const likes: string[] = []
  for (const c of clusters) {
    if (!c.isNegative && c.layer === 'core' && c.label && !likes.includes(c.label)) likes.push(c.label)
  }
  const dislikes: string[] = []
  for (const c of clusters) {
    if (c.isNegative && c.label && !dislikes.includes(c.label)) dislikes.push(c.label)
  }
  if (declaration?.avoid_preference && !dislikes.includes(declaration.avoid_preference)) {
    dislikes.push(declaration.avoid_preference)
  }

  // 4) recent_creation_direction：近 7 天事件最多的非负向簇（纯内存，无 LLM）
  const RECENT_WINDOW_DAYS = 7
  const recentByCluster: Record<string, number> = {}
  for (const e of events) {
    if (!e.clusterId) continue
    const age = (Date.now() - Date.parse(e.occurredAt)) / 86_400_000
    if (age > RECENT_WINDOW_DAYS) continue
    recentByCluster[e.clusterId] = (recentByCluster[e.clusterId] ?? 0) + 1
  }
  const negativeIds = new Set(clusters.filter((c) => c.isNegative).map((c) => c.clusterId))
  let recentDirection: { code: string; label: string; recentEvents: number } | null = null
  let best = 0
  for (const c of clusters) {
    if (c.isNegative || negativeIds.has(c.clusterId)) continue
    const n = recentByCluster[c.clusterId] ?? 0
    if (n > best) {
      best = n
      recentDirection = { code: c.code, label: c.label, recentEvents: n }
    }
  }

  return {
    schema_version: 2,
    updated_at: new Date().toISOString(),
    build_id: buildId,
    algo_version: ALGO_VERSION,
    rule_version: RULE_VERSION,
    embedding_model: EMBEDDING_MODEL,

    identity: {
      first_event_at: firstEventAt,
      last_event_at: lastEventAt,
      event_count_30d: eventCount30d,
      completeness: Math.min(1, completeness),
    },

    core: layers.core,
    exploration: layers.exploration,
    temporary: layers.temporary,

    domains: aggregateDomains(clusters),

    creation_purpose: {
      authoritative_source: 'creator_declaration.creator_goal',
      inferred: [] as unknown[],
    },
    content_preference_authority:
      'creator_declaration.{expression_profile,thinking_profile,narrative_preference,emotional_preference,quality_standard}',
    content_preference: {
      likes,
      dislikes,
    },
    creative_goals: creativeGoals,
    topic_interest: topicInterest,
    recent_creation_direction: recentDirection,

    behavior_reason_summary: {
      window_days: 90,
      mix: totalWeight > 0 ? reasonMix : {},
    },
  }
}
