// ============================================================
// Creator Interest Profile —— Feed 轻量补货（refill）
//
// 为什么需要：Feed 库存不足时旧实现直接 fire-and-forget runBuild，而 runBuild
// 第一步就是 supersedeOldBuild（清空该用户全部 active 卡），且耗时 20-150s。
// 结果就是用户正在翻的游标当场失效、重建期间翻页必然撞到"队列空"降级——
// 这正是"刷到哪里就没了"的直接根因。
//
// refill 与 runBuild 的分工：
//   runBuild  理解用户（拉事件/补 embedding/原因解释/聚类/分层/趋势/装配画像+造卡）
//             → 3 次 LLM、20-150s、清空旧队列
//   refill    只造卡（复用上次 build 落库的簇 → 候选生成 → 打分 → 追加队列）
//             → 1 次 LLM、秒级、不清空队列（翻页连续）
//
// 设计红线：
//   1. 只追加不 supersede —— 用户已拿到手的卡与游标绝不失效
//   2. 复用上次 build 的簇与 build_id —— 不重跑聚类，不做画像版本漂移
//   3. AI 理由只吃真实行为事实（facts 由 creator_events 现算，不编造数量）
//   4. 全程吞错：refill 是 fire-and-forget 后台任务，绝不影响 Feed 响应
//   5. 双重成本闸门：进程内在途锁 + 每用户最小间隔（与请求频率解耦）
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { cosineSimilarity, parseVectorColumn } from './vectorMath'
import { fetchActiveClusters, getLastBuild } from './interestRepo'
import {
  getOwnInspirationCandidates,
  getSavedMaterialCandidates,
  getActiveProjectCandidates,
  hardFilter,
  type Candidate,
} from './candidates'
import {
  getMarketCandidates,
  getExplorationCandidates,
  buildExplorationSeeds,
} from './suggestionSynthesizer'
import { scoreCandidate } from './ranking'
import {
  getActiveSuggestions,
  insertSuggestions,
  type SuggestionInsertInput,
} from './suggestionRepo'
import { generateAiReasons } from './reasonAi'
import { tagOverlapFor } from './tagVector'
import type { ClusterView } from './profileAssembly'
import type { InterestLayer, TrendDirection } from './types'
import {
  REFILL_MIN_INTERVAL_MS,
  REFILL_BATCH_SIZE,
  REFILL_REASON_TOP_N,
  REFILL_TEXT_DEDUPE_THRESHOLD,
  REFILL_LOCK_TTL_MS,
  REFILL_FACTS_WINDOW_DAYS,
} from './config'
import { runBuild } from './builder'

export type RefillReason =
  | 'ok'
  | 'locked'
  | 'no_build'
  | 'no_cluster'
  | 'no_candidate'
  | 'failed'

export interface RefillResult {
  added: number
  reason: RefillReason
}

/** refill 消费的簇上下文（builder 步骤 13 的 clusterData 精简版） */
interface RefillCluster {
  clusterId: string
  code: string
  label: string
  centroid: number[] | null
  tagEmbedding: number[] | null
  trend: TrendDirection
  lastSeenAt: string
  weight: number
  layer: InterestLayer
}

/** 单簇真实行为事实（AI 理由的红线输入：只放真实计数） */
interface ClusterFacts {
  create: number
  finalize: number
  save: number
}

interface ActiveClusterRow {
  id: string
  cluster_code: string | null
  label: string | null
  summary: string | null
  centroid: unknown
  tag_embedding: unknown
  layer: unknown
  weight: unknown
  confidence: unknown
  event_count: unknown
  project_count: unknown
  first_seen_at: unknown
  last_seen_at: unknown
  stats: unknown
}

// ── 进程内闸门 ──
// serverless 多实例不共享，因此最小间隔只是本实例的成本闸门；
// 跨实例重复补货的最坏代价是多出几张卡（按标题去重后无害），可接受。
const inflightUntil = new Map<string, number>()
const lastAttemptAt = new Map<string, number>()

// ── 解析辅助（DB 行字段全部按 unknown 防御处理）──

function parseLayer(v: unknown): InterestLayer {
  return v === 'core' || v === 'exploration' || v === 'temporary' ? v : 'exploration'
}

function parseTrend(v: unknown): TrendDirection {
  return v === 'rising' || v === 'declining' || v === 'dormant' ? v : 'stable'
}

function parseStats(stats: unknown): { trend: TrendDirection; keywords: string[] } {
  const s = (stats ?? {}) as { trend?: { direction?: unknown }; keywords?: unknown }
  const keywords = Array.isArray(s.keywords)
    ? s.keywords.filter((k): k is string => typeof k === 'string')
    : []
  return { trend: parseTrend(s.trend?.direction), keywords }
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function iso(v: unknown, fallback: string): string {
  return typeof v === 'string' && v ? v : fallback
}

function toRefillCluster(row: ActiveClusterRow, nowIso: string): RefillCluster {
  const { trend } = parseStats(row.stats)
  return {
    clusterId: row.id,
    code: row.cluster_code ?? 'no_cluster',
    label: row.label ?? '未命名方向',
    centroid: parseVectorColumn(row.centroid),
    tagEmbedding: parseVectorColumn(row.tag_embedding),
    trend,
    lastSeenAt: iso(row.last_seen_at, nowIso),
    weight: num(row.weight),
    layer: parseLayer(row.layer),
  }
}

/** 构造成 ClusterView 仅供 buildExplorationSeeds 挑种子，不落库不进画像 */
function toClusterView(row: ActiveClusterRow, nowIso: string): ClusterView {
  const { trend, keywords } = parseStats(row.stats)
  const weight = num(row.weight)
  return {
    clusterId: row.id,
    code: row.cluster_code ?? 'no_cluster',
    label: row.label ?? '未命名方向',
    summary: row.summary ?? '',
    layer: parseLayer(row.layer),
    weight,
    confidence: num(row.confidence),
    trend,
    rawScore: weight,
    eventCount: num(row.event_count),
    projectCount: num(row.project_count),
    // create/finalize/save 明细不参与种子选择，留 0；AI 理由的事实另从事件现算
    createCount: 0,
    finalizeCount: 0,
    saveCount: 0,
    firstSeenAt: iso(row.first_seen_at, iso(row.last_seen_at, nowIso)),
    lastSeenAt: iso(row.last_seen_at, nowIso),
    genuineRatio: 0,
    isNegative: weight < 0,
    topEvidence: [],
    domains: {},
    keywords,
  }
}

// ── 文本去重（refill 没有候选向量列可依赖，用标题 bigram 近似）──

function bigrams(s: string): Set<string> {
  const clean = s.replace(/\s+/g, '')
  const out = new Set<string>()
  if (clean.length <= 1) {
    if (clean) out.add(clean)
    return out
  }
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2))
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** 过滤掉与在库卡标题高度重合的新候选（避免补货补出一堆近义重复卡） */
function dedupeByText(candidates: Candidate[], existingTitles: string[]): Candidate[] {
  if (!existingTitles.length) return candidates
  const pools = existingTitles.map(bigrams)
  return candidates.filter((c) => {
    const cb = bigrams(c.title)
    for (const p of pools) {
      if (jaccard(cb, p) > REFILL_TEXT_DEDUPE_THRESHOLD) return false
    }
    return true
  })
}

// ── 取数 ──

/** 近 30 天"已写过"与"已点 ✕"的主题向量（与 builder 步骤 13 同口径） */
async function loadFilterEmbeddings(
  supabase: SupabaseClient,
  userId: string
): Promise<{ written: number[][]; dismissed: number[][] }> {
  const since = new Date()
  since.setDate(since.getDate() - 30)
  const [{ data: writtenRows }, { data: dismissedRows }] = await Promise.all([
    supabase
      .from('creator_events')
      .select('embedding')
      .eq('user_id', userId)
      .eq('event_type', 'work_generate')
      .gte('occurred_at', since.toISOString())
      .limit(50),
    supabase
      .from('creator_events')
      .select('embedding')
      .eq('user_id', userId)
      .eq('event_type', 'recommend_dismiss')
      .gte('occurred_at', since.toISOString())
      .limit(50),
  ])
  return {
    written: (writtenRows ?? [])
      .map((r) => parseVectorColumn((r as { embedding: unknown }).embedding))
      .filter((e): e is number[] => !!e),
    dismissed: (dismissedRows ?? [])
      .map((r) => parseVectorColumn((r as { embedding: unknown }).embedding))
      .filter((e): e is number[] => !!e),
  }
}

/**
 * 按簇聚合真实行为计数，供 AI 理由的事实包使用。
 * 事实红线：这里的每个数字都来自 creator_events 实际行数，绝不估算。
 */
async function loadClusterFacts(
  supabase: SupabaseClient,
  userId: string
): Promise<Map<string, ClusterFacts>> {
  const since = new Date()
  since.setDate(since.getDate() - REFILL_FACTS_WINDOW_DAYS)
  const { data, error } = await supabase
    .from('creator_events')
    .select('cluster_id, event_type')
    .eq('user_id', userId)
    .gte('occurred_at', since.toISOString())
    .limit(500)
  const out = new Map<string, ClusterFacts>()
  if (error || !data) return out
  for (const r of data as Array<{ cluster_id?: string | null; event_type?: string }>) {
    const cid = r.cluster_id
    if (!cid) continue
    if (!out.has(cid)) out.set(cid, { create: 0, finalize: 0, save: 0 })
    const f = out.get(cid)!
    if (r.event_type === 'work_generate') f.create += 1
    else if (r.event_type === 'work_finalize') f.finalize += 1
    else if (r.event_type === 'material_save') f.save += 1
  }
  return out
}

// ── 打分 + 落库结构 ──

function buildInsertInput(
  cand: Candidate,
  clusters: RefillCluster[],
  facts: Map<string, ClusterFacts>,
  now: Date
): SuggestionInsertInput {
  // 簇匹配：只用 embedding 余弦兜底（refill 无 forceBind / projectId 直连的上下文）
  let matched: RefillCluster | null = null
  if (cand.embedding && cand.embedding.length === 1024) {
    let bestSim = 0.5
    for (const c of clusters) {
      if (!c.centroid?.length) continue
      const sim = cosineSimilarity(cand.embedding, c.centroid)
      if (sim > bestSim) {
        bestSim = sim
        matched = c
      }
    }
  }

  const daysSinceLastInCluster = matched
    ? Math.max(0, Math.floor((now.getTime() - Date.parse(matched.lastSeenAt)) / 86_400_000))
    : null

  const semanticSim =
    matched && cand.embedding && cand.embedding.length === 1024
      ? Math.round(cosineSimilarity(cand.embedding, matched.centroid!) * 1000) / 1000
      : null

  const scored = scoreCandidate({
    candidate: cand,
    semanticSimilarity: semanticSim,
    trend: matched?.trend ?? null,
    daysSinceLastInCluster,
    tagOverlapRatio: tagOverlapFor(cand.embedding, matched?.tagEmbedding),
  })

  // 事实包：只放真实计数；无匹配簇/无计数 → facts 为空 → AI 理由自动走模板（红线）
  const f = matched ? facts.get(matched.clusterId) : undefined
  const factList: Array<{ type: string; count: number; cluster_label: string }> = []
  if (matched && f) {
    if (f.create > 0) factList.push({ type: 'create', count: f.create, cluster_label: matched.label })
    if (f.finalize > 0) factList.push({ type: 'finalize', count: f.finalize, cluster_label: matched.label })
    if (f.save > 0) factList.push({ type: 'save', count: f.save, cluster_label: matched.label })
  }

  const evidence: Record<string, unknown> = matched
    ? {
        cluster_label: matched.label,
        cluster_code: matched.code,
        facts: factList,
        gap_reason:
          cand.slot === 'core_gap' ? `你在「${matched.label}」关注但还未写过` : null,
        source: cand.source,
        matched_similarity: semanticSim,
        generated_by: 'refill',
      }
    : {
        facts: [],
        source: cand.source,
        gap_reason: cand.source === 'exploration' ? '探索性方向：基于你的兴趣扩展' : null,
        generated_by: 'refill',
      }

  return {
    clusterCode: matched?.code ?? 'no_cluster',
    slot: cand.slot,
    source: cand.source,
    title: cand.title,
    description: cand.description,
    topic: cand.topic,
    formHint: cand.formHint,
    score: scored.score,
    scoreBreakdown: scored.breakdown,
    evidence,
    marketRefs: cand.marketRefs ? { refs: cand.marketRefs } : null,
  }
}

async function attachAiReasons(
  items: SuggestionInsertInput[],
  materialTitles: string[]
): Promise<void> {
  if (!items.length) return
  const topIdx = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => b.it.score - a.it.score)
    .slice(0, REFILL_REASON_TOP_N)

  const outputs = await generateAiReasons(
    topIdx.map(({ it }) => ({
      title: it.title,
      clusterLabel: (it.evidence?.cluster_label as string) ?? null,
      facts: (it.evidence?.facts as Array<Record<string, unknown>>) ?? [],
      gapReason: (it.evidence?.gap_reason as string) ?? null,
      materialTitles,
    }))
  )
  topIdx.forEach(({ it }, seq) => {
    const r = outputs[seq]
    if (!r) return
    it.coreQuestion = r.coreQuestion
    it.whyRecommend = r.whyRecommend
    it.creationAngle = r.creationAngle
    it.relatedKnowledge = r.relatedKnowledge
    it.reasonSource = r.reasonSource
  })
}

// ── 主入口 ──

/**
 * 轻量补货：复用上次 build 的簇造一批新卡，**追加**到 active 队列。
 * 任何失败都返回 { added: 0, reason }，绝不抛出（调用方是 fire-and-forget）。
 */
export async function refillSuggestions(
  supabase: SupabaseClient,
  userId: string
): Promise<RefillResult> {
  const startedAt = Date.now()

  // 闸门 1：进程内在途锁（含 TTL 自愈，防进程冻结遗留死锁）
  const lockUntil = inflightUntil.get(userId) ?? 0
  if (lockUntil > startedAt) return { added: 0, reason: 'locked' }
  inflightUntil.set(userId, startedAt + REFILL_LOCK_TTL_MS)

  try {
    // 闸门 2：最小间隔（在途锁只挡并发，挡不住串行高频刷新）
    if (startedAt - (lastAttemptAt.get(userId) ?? 0) < REFILL_MIN_INTERVAL_MS) {
      return { added: 0, reason: 'locked' }
    }
    lastAttemptAt.set(userId, startedAt)

    // 需要一次成功的 build 作为簇与 build_id 的来源
    const lastBuild = await getLastBuild(supabase, userId)
    const buildId = lastBuild?.id
    if (!buildId) return { added: 0, reason: 'no_build' }

    const nowIso = new Date().toISOString()
    const raw = (await fetchActiveClusters(supabase, userId)) as unknown as ActiveClusterRow[]
    if (!raw.length) return { added: 0, reason: 'no_cluster' }

    const clusters = raw.map((r) => toRefillCluster(r, nowIso))
    const views = raw.map((r) => toClusterView(r, nowIso))

    // 探索种子沿用 builder 口径（core 优先 → weight → code），保证补货方向不漂移
    const { seeds, nonCoreLabels } = buildExplorationSeeds(views)
    const topCentroid =
      clusters.find((c) => c.layer === 'core')?.centroid ?? clusters[0]?.centroid ?? null

    const [s1, s2, s3, s4, s5] = await Promise.all([
      getOwnInspirationCandidates(supabase, userId),
      getMarketCandidates(topCentroid, 4),
      getSavedMaterialCandidates(supabase, userId),
      getExplorationCandidates(seeds, nonCoreLabels, { count: REFILL_BATCH_SIZE }),
      getActiveProjectCandidates(supabase, userId),
    ])

    const all: Candidate[] = [...s1, ...s2, ...s3, ...s4, ...s5]
    if (!all.length) return { added: 0, reason: 'no_candidate' }

    // 已写过 / 已点 ✕ 的主题向量过滤
    const { written, dismissed } = await loadFilterEmbeddings(supabase, userId)
    // 队列内去重传空数组：refill 不 supersede，在库卡仍要保留，改用标题文本去重
    let filtered = hardFilter(all, written, dismissed, [])

    const active = await getActiveSuggestions(supabase, userId, 50)
    filtered = dedupeByText(filtered, active.map((r) => r.title))
    if (!filtered.length) return { added: 0, reason: 'no_candidate' }

    const facts = await loadClusterFacts(supabase, userId)
    const items = filtered.map((c) => buildInsertInput(c, clusters, facts, new Date(startedAt)))

    await attachAiReasons(
      items,
      [...new Set(s3.map((c) => c.title))]
    )

    const added = await insertSuggestions(supabase, userId, buildId, items)
    return { added, reason: added > 0 ? 'ok' : 'no_candidate' }
  } catch (e) {
    console.error('[interest] refill 失败:', e instanceof Error ? e.message : e)
    return { added: 0, reason: 'failed' }
  } finally {
    inflightUntil.delete(userId)
  }
}

/**
 * Feed 库存不足时的统一补货入口（fire-and-forget 调用）。
 * 优先轻量 refill；refill 不可行（从未成功 build / 无活跃簇 / 补货失败）时
 * 才回退完整 runBuild——那时没有更好的选择，重建是唯一出路。
 */
export async function topUpQueue(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  try {
    const r = await refillSuggestions(supabase, userId)
    if (r.reason === 'no_build' || r.reason === 'no_cluster' || r.reason === 'failed') {
      await runBuild(supabase, userId, 'incremental')
    }
  } catch (e) {
    console.error('[interest] topUpQueue 失败:', e instanceof Error ? e.message : e)
  }
}
