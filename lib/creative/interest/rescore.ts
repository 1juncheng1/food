// ============================================================
// Creator Interest Profile —— 在线重排（RULE v5）
//
// 为什么要有这个模块（生产实锤，不是理论推演）：
//   在此之前 score 是在 build/refill **写库时**算死的，interest_suggestions.score
//   落库后到过期（14 天）为止再也不动。而它依赖的每一个量都是活的：
//     最近一条行为距今天数（每天 +1）／簇趋势方向／近期行为质心／✕ 口味惩罚
//   结果是一支排序冻结在 14 天前的队列：用户兴趣已经漂移、他刚点过 ✕ 的方向
//   在下一页原样回来、今天才热起来的趋势排在队伍末尾——全都因为分是死的。
//
// 修法（也是业界标准做法）：离线只做两件事——生成候选 + 抽取「卡片固有特征」；
// 打分与排序挪到读路径，用「当下的画像」现场算。由此得到三个结果：
//   C-1 排序永远反映当下，不再是一张过期快照
//   C-2 ✕ 立刻作用于同簇所有存量卡，而不是只把这一张藏起来
//   C-3 改评分权重的代价，从「清空队列 + 3 次 LLM + 用户看着洞等 30 秒」
//       降为「改一行代码、发一次版」
//
// 铁律：这里不得出现任何评分权重或魔法数，公式唯一入口是 ranking.scoreCandidate。
// 离线（builder/refill）与在线（本模块）共用同一个函数 —— 一旦有人把公式抄成两份，
// 两边立刻漂移，就会重新长出"两把尺子"。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  RANKING_VERSION,
  TASTE_PENALTY_WINDOW_DAYS,
  ENGAGEMENT_WINDOW_DAYS,
} from './config'
import { NO_CLUSTER, buildEngagementMaps, engagementFactor } from './engagement'
import { buildTasteMap } from './tasteModel'
import {
  scoreCandidate,
  recentBehaviorCentroid,
  recentSimilarityOf,
  tasteFactorFor,
  type CentroidSource,
  type TasteEntry,
} from './ranking'
import { cosineSimilarity, parseVectorColumn } from './vectorMath'
import type { TrendDirection } from './types'
import type { Candidate } from './candidates'

// ───────────────────────── 卡片的固有特征 ─────────────────────────

/**
 * 落库在 interest_suggestions.ranking_features 的结构。
 *
 * 收录标准是「不随时间和用户状态变化的、属于这张卡自己的东西」。
 * 凡是需要读当场画像才能算的一律不进这里 —— 那正是要在线实时算的部分。
 *
 * knowledge 是唯一的妥协：它是「用户的知识库能支撑这个方向多少」，按理会随用户
 * 新增知识单元而变化。但知识库是慢变量，而算它要额外拉知识表 + 向量比对；
 * 用户新增知识本身会产生事件并触发 refill，新卡自然带上最新值。为了不让读路径
 * 背上一个重依赖，这里按 build 时刻的值冻结。
 */
export interface RankingFeatures {
  ranking_version: string
  /** 内容固有价值 [0,1]（候选自带，等于 Candidate.contentValue） */
  quality: number
  /** 四维标签命中率 [0,1] */
  tagOverlap: number
  /** 知识资产覆盖度 [0,1]；用户无知识单元时为 null → 该维度权重在职时重分配 */
  knowledge: number | null
}

/** 离线落库时的构造函数（builder/refill/firstWorkSeed 用） */
export function buildRankingFeatures(input: {
  quality: number
  tagOverlap: number
  knowledge: number | null
}): RankingFeatures {
  return {
    ranking_version: RANKING_VERSION,
    quality: clamp01(input.quality),
    tagOverlap: clamp01(input.tagOverlap),
    knowledge:
      input.knowledge === null || !Number.isFinite(input.knowledge)
        ? null
        : clamp01(input.knowledge),
  }
}

/**
 * 读回风控：版本不匹配 / 字段畸形一律返回 null。
 *
 * 版本不匹配时宁可退回行里的库 score，也不能用旧特征喂新公式 ——
 * 那正是 v4 之前「同一队列 v2 卡与 v3 卡混排」的原形态。
 */
export function parseRankingFeatures(v: unknown): RankingFeatures | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (o.ranking_version !== RANKING_VERSION) return null
  const quality = finiteNumber(o.quality)
  const tagOverlap = finiteNumber(o.tagOverlap)
  if (quality === null || tagOverlap === null) return null
  return {
    ranking_version: RANKING_VERSION,
    quality: clamp01(quality),
    tagOverlap: clamp01(tagOverlap),
    knowledge: finiteNumber(o.knowledge),
  }
}

// ───────────────────────── 重排上下文 ─────────────────────────

export interface RescoreCluster extends CentroidSource {
  code: string
  trend: TrendDirection | null
  /**
   * 簇分层（core/exploration/temporary）。评分用不到，但热点召回要挑 core 向量，
   * 顺带带上它，读路径就能只查一次簇表（原本重排一处、热点召回一处各查一遍）。
   */
  layer?: string | null
}

export interface RescoreContext {
  now: Date
  /** cluster_code → 簇上下文（质心/趋势/最近行为时间） */
  clusters: Map<string, RescoreCluster>
  /** 近期行为质心（由全部活跃簇按 权重 × 时间衰减 加权得到） */
  recentCentroid: number[] | null
  /** cluster_code → 口味惩罚（来自 ✕ 原因） */
  tasteByCluster: Map<string, TasteEntry>
  /**
   * 曝光/点击的原始事件行（{ target_id, event_type }）。
   *
   * 为什么存原始行而不是直接存聚合结果：簇归属要等 applyRescore 拿到"正在排的
   * 这批卡"才能算出来（impression/click 事件不带 payload，只有 target_id）。
   * 存原始行 = 少一次查表，且簇归属对这批卡是精确的。
   */
  engagementRows?: readonly Record<string, unknown>[]
  /**
   * 卡片 id → cluster_code。
   *
   * 关键：这张表必须来自 interest_suggestions 而不是"正在排的这批卡"。
   * card 14 天就过期，而簇级学习要攒够样本（8 次曝光）才能开口说话——
   * 若只认当批卡，等样本攒够时承载样本的卡早已退场，簇级统计恒为空，
   * 学习永远无法推广到该方向后续的新卡，整个 ② 层就白做了。
   */
  cardClusters?: Map<string, string>
}

/** 构造上下文。clusters 为 raw DB 行或已解析对象均可（重心 moves 在这里做） */
export function buildRescoreContext(input: {
  clusters: readonly RescoreCluster[]
  tasteByCluster?: Map<string, TasteEntry>
  engagementRows?: readonly Record<string, unknown>[]
  cardClusters?: Map<string, string>
  now?: Date
}): RescoreContext {
  const now = input.now ?? new Date()
  const clusters = new Map<string, RescoreCluster>()
  for (const c of input.clusters) clusters.set(c.code, c)
  return {
    now,
    clusters,
    // 复用既有的「簇质心 × 权重 × 半衰衰减」加权：与离线同公式，零重实现
    recentCentroid: recentBehaviorCentroid(input.clusters, now),
    tasteByCluster: input.tasteByCluster ?? new Map(),
    engagementRows: input.engagementRows ?? [],
    cardClusters: input.cardClusters ?? new Map(),
  }
}

// ───────────────────────── 单行重算 ─────────────────────────

/** 参与在线重排所需的最小字段集（SuggestionRow 的超集兼容） */
export interface RescoreableRow {
  id: string
  cluster_code: string
  slot: string
  source: string
  score: number
  score_breakdown?: Record<string, number> | null
  embedding?: unknown
  ranking_features?: unknown
}

export interface RescoredValue {
  score: number
  breakdown: Record<string, number>
}

/**
 * 用「当下的画像」重算一张卡的分。
 *
 * 返回 null 表示这张卡不可在线重排（缺特征 / 特征版本落后）——调用方应保留库 score。
 * 这是 v5 迁移窗口内的正常态，不是错误：旧卡随 14 天过期或被 supersede 自然消失。
 */
export function rescoreRow(
  row: RescoreableRow,
  ctx: RescoreContext
): RescoredValue | null {
  const features = parseRankingFeatures(row.ranking_features)
  if (!features) return null

  const code = row.cluster_code || 'no_cluster'
  const cluster = ctx.clusters.get(code) ?? null
  const slot = normalizeSlot(row.slot)
  const source = normalizeSource(row.source)
  const embedding = parseEmbedding(row.embedding)

  // 1. 语义匹配：候选取负当前簇质心。质心会随用户行为漂移 ——
  //    这正是离线算死时永远抓不到的那部分变化。
  const semanticSimilarity =
    embedding && cluster?.centroid?.length
      ? Math.round(cosineSimilarity(embedding, cluster.centroid) * 1000) / 1000
      : null

  // 2. 簇新鲜度：距该簇最近一条行为的天数。每天都 +1，离线值必然过期。
  let daysSinceLastInCluster: number | null = null
  if (cluster) {
    const parsed = Date.parse(cluster.lastSeenAt)
    if (Number.isFinite(parsed)) {
      daysSinceLastInCluster = Math.max(
        0,
        Math.floor((ctx.now.getTime() - parsed) / 86_400_000)
      )
    }
  }

  // 3. 近期创作贴合度 + 口味惩罚：前者随用户近两周行为走，后者随 ✕ 走
  const recentSimilarity = recentSimilarityOf(embedding, ctx.recentCentroid)
  const tasteFactor = tasteFactorFor(ctx.tasteByCluster.get(code), slot)

  // 4. 套用与离线**完全同一个**评分函数。此处若重写一遍公式，两边必然漂移。
  const scored = scoreCandidate({
    candidate: pseudoCandidate(source, slot, embedding, features.quality),
    semanticSimilarity,
    trend: cluster?.trend ?? null,
    daysSinceLastInCluster,
    tagOverlapRatio: features.tagOverlap,
    recentSimilarity,
    knowledgeScore: features.knowledge,
    tasteFactor,
  })

  return {
    score: scored.score,
    breakdown: scored.breakdown as unknown as Record<string, number>,
  }
}

// ───────────────────────── 批量重排 + 排序 ─────────────────────────

/**
 * 对整批卡就地重排并返回新的有序列表（score DESC，同分按 id ASC 稳定）。
 *
 * 不可重排的行保留原 score —— 它们在这一批里是少数且会过期；
 * 与其把整批判死，不如允许少量的口径混合并让它自然收敛。
 */
export function applyRescore<T extends RescoreableRow>(
  rows: T[],
  ctx: RescoreContext | null
): T[] {
  // 拿不到上下文（簇查询失败 / 迁移未落地导致全批无特征）：保持原样。
  // 数据库已按 score DESC + id ASC 取回，顺序本身就是可用的。
  if (!ctx) return rows

  // 曝光—反馈闭环：先按"正在排的这批卡"把事件行聚合成按卡/按簇两张表。
  // 拿不到事件（迁移/查询失败）时两张表为空 → 乘子恒 1 → 等价于未启用。
  const { byCard, byCluster } = buildEngagementMaps(
    ctx.engagementRows ?? [],
    ctx.cardClusters ?? new Map()
  )

  const out = rows.map((r) => {
    const factor = engagementFactor(
      byCard.get(r.id),
      byCluster.get(r.cluster_code || NO_CLUSTER)
    )
    const nextValue = rescoreRow(r, ctx)
    if (!nextValue) {
      // 不可重排（缺特征/特征版本落后）：保留库 score。但互动乘子照样生效——
      // 它只依赖曝光事件，不依赖 ranking_features，不该因为特征缺失被豁免，
      // 否则"看腻了的旧卡"反而比新卡更占便宜。
      if (factor === 1) return r
      return { ...r, score: round4(safeScore(r.score) * factor) }
    }
    return {
      ...r,
      score: round4(nextValue.score * factor),
      score_breakdown: { ...nextValue.breakdown, engagement: factor },
    }
  })
  return sortByScore(out)
}

/** interest_suggestions 行 → 卡片 id → cluster_code */
function cardClusterMap(rows: readonly Record<string, unknown>[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const r of rows) {
    const id = typeof r.id === 'string' ? r.id : null
    if (!id) continue
    m.set(id, typeof r.cluster_code === 'string' && r.cluster_code ? r.cluster_code : 'no_cluster')
  }
  return m
}

/** score DESC + id ASC 稳定排序（与既有 Feed 排序方向一致） */
export function sortByScore<T extends { score: number; id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.id.localeCompare(b.id)
  })
}

// ───────────────────────── 读路径上下文装载 ─────────────────────────

/**
 * 拉「当下的画像」构造重排上下文。
 *
 * 两个查询并行且全程吞错：这是 Feed/dashboard 的热路径，读画像失败只应让这一次
 * 请求退回库 score（等价于今天之前的行为），绝不能 500 或拖慢响应。
 *
 * 返回 null 表示上下文完全拿不到 —— 调用方应跳过重排直接用原库 score。
 */
export async function loadRescoreContext(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<RescoreContext | null> {
  try {
    const tasteSince = new Date(
      now.getTime() - TASTE_PENALTY_WINDOW_DAYS * 86_400_000
    ).toISOString()

    const engagementSince = new Date(
      now.getTime() - ENGAGEMENT_WINDOW_DAYS * 86_400_000
    ).toISOString()

    // 卡片 id → cluster_code 的回看窗口要比曝光窗口更长：
    // 曝光事件最老 30 天，而产生它的卡可能更早创建。取 2 倍留足余量。
    const cardSince = new Date(
      now.getTime() - ENGAGEMENT_WINDOW_DAYS * 2 * 86_400_000
    ).toISOString()

    const [clustersRes, dismissRes, engagementRes, cardClustersRes] = await Promise.all([
      supabase
        .from('interest_clusters')
        .select('cluster_code, centroid, weight, last_seen_at, stats, layer')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('weight', { ascending: false }),
      supabase
        .from('creator_events')
        .select('payload, occurred_at')
        .eq('user_id', userId)
        .eq('event_type', 'recommend_dismiss')
        .gte('occurred_at', tasteSince)
        .limit(50),
      // 曝光—反馈闭环的原料。与上面两个查询并行，不增加串行延迟。
      // 失败不当上下文失败：拿不到互动数据只是"这次不学习"，退回无乘子排序。
      supabase
        .from('creator_events')
        .select('target_id, event_type')
        .eq('user_id', userId)
        .in('event_type', ['recommend_impression', 'recommend_click'])
        .gte('occurred_at', engagementSince)
        .limit(1000),
      // 簇归属字典。impression/click 事件不带 payload，只有 target_id，
      // 卡退场后就没法从"正在排的这批卡"反查它的簇了 —— 只能回表查。
      // 也正因此不能省：省掉 = 簇级学习永远学不到任何东西（见 cardClusters 注释）。
      supabase
        .from('interest_suggestions')
        .select('id, cluster_code')
        .eq('user_id', userId)
        .gte('created_at', cardSince)
        .limit(1000),
    ])

    if (clustersRes.error) {
      console.error('[rescore] 读活跃簇失败:', clustersRes.error.message)
      return null
    }

    const clusters: RescoreCluster[] = ((clustersRes.data ?? []) as Array<
      Record<string, unknown>
    >).map((r) => {
      const lastSeenAt =
        typeof r.last_seen_at === 'string' ? r.last_seen_at : now.toISOString()
      return {
        code: typeof r.cluster_code === 'string' ? r.cluster_code : 'no_cluster',
        centroid: parseVectorColumn(r.centroid),
        trend: parseTrendFromStats(r.stats),
        lastSeenAt,
        weight:
          typeof r.weight === 'number' && Number.isFinite(r.weight) ? r.weight : 0,
        layer: typeof r.layer === 'string' ? r.layer : null,
      }
    })

    const dismissRows = (dismissRes.data ?? []) as Array<Record<string, unknown>>
    return buildRescoreContext({
      clusters,
      tasteByCluster: buildTasteMap(
        dismissRows.map((r) => ({
          occurredAt: typeof r.occurred_at === 'string' ? r.occurred_at : '',
          payload: (r.payload as Record<string, unknown>) ?? null,
        })),
        now
      ),
      engagementRows: (engagementRes.data ?? []) as Array<Record<string, unknown>>,
      cardClusters: cardClusterMap(
        (cardClustersRes.data ?? []) as Array<Record<string, unknown>>
      ),
      now,
    })
  } catch (e) {
    console.error('[rescore] 装载重排上下文失败:', e instanceof Error ? e.message : String(e))
    return null
  }
}

// ───────────────────────── 内部工具 ─────────────────────────

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function round4(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 10000) / 10000 : 0
}

function safeScore(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** pgvector 经 PostgREST 回来是 "[0.1,0.2]" 字符串形态，统一用既有解析器 */
function parseEmbedding(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[]
  return parseVectorColumn(v)
}

function parseTrendFromStats(stats: unknown): TrendDirection | null {
  const s = (stats ?? {}) as { trend?: { direction?: unknown } }
  const d = s.trend?.direction
  return d === 'rising' || d === 'declining' || d === 'dormant' || d === 'stable'
    ? d
    : null
}

function normalizeSlot(v: string): Candidate['slot'] {
  return v === 'core_gap' ||
    v === 'evidence_followup' ||
    v === 'exploration' ||
    v === 'continuation'
    ? v
    : 'exploration'
}

function normalizeSource(v: string): Candidate['source'] {
  return v === 'own_inspiration' ||
    v === 'ci_market' ||
    v === 'saved_material' ||
    v === 'exploration' ||
    v === 'active_project' ||
    v === 'creator_knowledge'
    ? v
    : 'exploration'
}

/**
 * 用 DB 行还原出一个仅供打分使用的最小 Candidate。
 *
 * 只有 scoreCandidate 真正读取的三个字段（source/slot/contentValue）取真值，
 * 其余全是占位值。这是刻意的：将来若有人在评分里加入对 title/description 的依赖，
 * 这里的空串会立刻在测试里炸出来，而不是在线上悄悄给出脏分。
 */
function pseudoCandidate(
  source: Candidate['source'],
  slot: Candidate['slot'],
  embedding: number[] | null,
  quality: number
): Candidate {
  return {
    source,
    slot,
    title: '',
    description: '',
    topic: '',
    formHint: '',
    embedding,
    clusterCode: null,
    contentValue: quality,
    marketRefs: null,
  }
}
