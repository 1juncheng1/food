// ============================================================
// Creator Interest Profile —— 评分 v2 + 分槽多样性 + 日种子
//
// 输出两类函数：
//   1. scoreCandidate   —— builder 落库前打分（v2 五因子：
//                          InterestMatch/RecentBehavior/Trend/Quality/Explore，
//                          权重全部来自 config.RANKING_WEIGHTS_V2）
//   2. selectSlots      —— API 读 active 队列后分槽选 3 张，保证多样性
//
// 日种子（daily seed）：同用户同日稳定、跨日变化的确定性打散，
// 避免"用户每次刷新看到完全不同的 Top1"，仍允许小幅轮换。
// ============================================================

import type { Candidate } from './candidates'
import type { TrendDirection } from './types'
import {
  RANKING_WEIGHTS_V3,
  INTEREST_SEMANTIC_RATIO,
  INTEREST_TAG_RATIO,
  SEMANTIC_SIM_FLOOR,
  SEMANTIC_SIM_RANGE,
  EXPLORATION_SEMANTIC_FLOOR,
  TREND_FACTOR,
  EXPLORE_SLOT_FACTOR,
  RECENCY_LADDER,
  RECENCY_NO_EVENTS,
  RECENCY_SIM_FLOOR,
  RECENCY_SIM_RANGE,
  RECENCY_NO_SIGNAL_SIM,
  RECENT_BEHAVIOR_HALF_LIFE_DAYS,
  TASTE_SLOT_PENALTY,
  type DismissReasonCode,
} from './config'
import { cosineSimilarity } from './vectorMath'

/**
 * core 簇 weight≥该阈值时，允许同簇出现 2 张（仍受总分上限约束）。
 * 自适应规则在 selectSlots 内消费。
 */
export const CORE_WEIGHT_ALLOW_DUP_THRESHOLD = 0.8

// ──────────────────────────────────────────────────────────
// 打分（builder 用）
// ──────────────────────────────────────────────────────────

export interface CandidateScoreInput {
  candidate: Candidate
  /** 候选与所配簇质心的余弦相似度（bge-m3）；无匹配簇=null */
  semanticSimilarity: number | null
  /**
   * 四维标签命中率（WF4 接入；0-1）。
   * 缺省 1 = 标签维度按满分兜底（无标签数据时不打压候选）。
   */
  tagOverlapRatio?: number
  /** 所配簇趋势方向；无簇=null → 按 stable 中性处理 */
  trend: TrendDirection | null
  /** 距上次该簇事件的天数（null=新簇/无事件） */
  daysSinceLastInCluster: number | null
  /**
   * v3：候选与「近期行为质心」的余弦相似度。
   * null = 算不出来（无质心 / 候选无向量）→ 该维度权重按比例重分配给其余维度。
   *
   * 与 daysSinceLastInCluster 的区别：后者回答"这个簇最近有没有动静"，
   * 前者回答"这张卡贴不贴用户这两周正在做的事"。两者都叫"近期"，
   * 但一个是簇维度、一个是候选维度，v2 把它们混在一起是"推荐复述历史"的根因。
   */
  recentSimilarity?: number | null
  /**
   * v3：知识资产覆盖度（0-1）。用户已确认的知识单元能支撑这个方向 → 更高。
   * null = 该用户没有可用知识单元 → 权重重分配（没有知识库不该被扣分）。
   */
  knowledgeScore?: number | null
  /**
   * v3：口味惩罚乘子（0-1]，来自 ✕ 原因。默认 1（不惩罚）。
   * 乘在加权和之后：它表达"这张卡能不能要"，不是"这个方向重不重要"。
   */
  tasteFactor?: number
}

export interface CandidateScore {
  score: number
  breakdown: {
    interestMatch: number
    recentBehavior: number
    trend: number
    quality: number
    explore: number
    /** v3：仅在 recentSimilarity 可用时出现 */
    recency?: number
    /** v3：仅在用户有可用知识单元时出现 */
    knowledge?: number
    /** v3：仅在做了口味惩罚时出现（<1） */
    taste?: number
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

/**
 * 评分公式 v2。所有因子归一化到 [0,1]，加权求和后 score ∈ [0,1]。
 *
 * InterestMatch（0.4）= 0.7×语义匹配 + 0.3×标签命中；
 *   语义分 = (sim - floor) / range，无簇时探索源给地板、其他源 0
 * RecentBehavior（0.2）：距该簇最近行为的新鲜度阶梯
 * Trend（0.2）：簇趋势方向映射，无信号按 stable 中性
 * Quality（0.1）：候选自带内容价值
 * Explore（0.1）：槽位探索性（exploration > core_gap > followup > continuation）
 */
export function scoreCandidate(input: CandidateScoreInput): CandidateScore {
  const c = input.candidate

  // 1. 兴趣匹配 = 语义 + 标签（WF4 前标签兜底 1）
  let semanticScore: number
  if (input.semanticSimilarity === null) {
    semanticScore = c.source === 'exploration' ? EXPLORATION_SEMANTIC_FLOOR : 0
  } else {
    semanticScore = clamp01((input.semanticSimilarity - SEMANTIC_SIM_FLOOR) / SEMANTIC_SIM_RANGE)
  }
  const tagOverlap = clamp01(input.tagOverlapRatio ?? 1)
  const interestMatch =
    INTEREST_SEMANTIC_RATIO * semanticScore + INTEREST_TAG_RATIO * tagOverlap

  // 2. 行为新鲜度：距该簇最近事件天数阶梯
  let recentBehavior: number
  if (input.daysSinceLastInCluster === null) {
    recentBehavior = RECENCY_NO_EVENTS
  } else {
    const d = input.daysSinceLastInCluster
    recentBehavior = RECENCY_LADDER.find(([maxDays]) => d <= maxDays)![1]
  }

  // 3. 趋势：无簇/无信号 → stable 中性
  const trendScore = TREND_FACTOR[input.trend ?? 'stable']

  // 4. 内容质量（候选自带 0-1）
  const quality = clamp01(c.contentValue)

  // 5. 探索性（槽位维度）
  const explore = EXPLORE_SLOT_FACTOR[c.slot]

  // 6. v3 近期创作行为：候选贴不贴"用户这两周正在做的事"
  const recency =
    input.recentSimilarity === null || input.recentSimilarity === undefined
      ? null
      : clamp01((input.recentSimilarity - RECENCY_SIM_FLOOR) / RECENCY_SIM_RANGE)

  // 7. v3 知识资产覆盖度
  const knowledge =
    input.knowledgeScore === null || input.knowledgeScore === undefined
      ? null
      : clamp01(input.knowledgeScore)

  // ── 加权求和（信号缺失的维度按权重比例重分配，不按 0 计）──
  const dims: Array<{ key: keyof typeof RANKING_WEIGHTS_V3; weight: number; value: number | null }> = [
    { key: 'recency', weight: RANKING_WEIGHTS_V3.recency, value: recency },
    { key: 'interestMatch', weight: RANKING_WEIGHTS_V3.interestMatch, value: interestMatch },
    { key: 'knowledge', weight: RANKING_WEIGHTS_V3.knowledge, value: knowledge },
    { key: 'trend', weight: RANKING_WEIGHTS_V3.trend, value: trendScore },
    { key: 'recentBehavior', weight: RANKING_WEIGHTS_V3.recentBehavior, value: recentBehavior },
    { key: 'quality', weight: RANKING_WEIGHTS_V3.quality, value: quality },
    { key: 'explore', weight: RANKING_WEIGHTS_V3.explore, value: explore },
  ]
  const usable = dims.filter((d) => d.value !== null)
  const weightSum = usable.reduce((a, d) => a + d.weight, 0)
  const raw =
    weightSum > 0
      ? usable.reduce((a, d) => a + (d.weight / weightSum) * (d.value as number), 0)
      : 0

  // 口味惩罚：乘在最外层，只作用于"能不能要"，不污染任何维度的观测值
  const taste = clamp01(input.tasteFactor ?? 1)
  const score = raw * taste

  const used = new Set(usable.map((d) => d.key))
  return {
    score: round3(clamp01(score)),
    breakdown: {
      interestMatch: round3(interestMatch),
      recentBehavior: round3(recentBehavior),
      trend: round3(trendScore),
      quality: round3(quality),
      explore: round3(explore),
      ...(used.has('recency') ? { recency: round3(recency as number) } : {}),
      ...(used.has('knowledge') ? { knowledge: round3(knowledge as number) } : {}),
      ...(taste < 1 ? { taste: round3(taste) } : {}),
    },
  }
}

// ──────────────────────────────────────────────────────────
// v3：近期行为质心（builder 与 refill 共用）
// ──────────────────────────────────────────────────────────

export interface CentroidSource {
  centroid: number[] | null
  weight: number
  lastSeenAt: string
}

/**
 * 按「簇权重 × 时间衰减」加权平均得到一个"近期行为质心"。
 *
 * 为什么用簇质心加权而不是重扫事件：builder 与 refill 手里都只有簇，
 * 重扫事件意味着 refill 要多一次全量查询（它之所以快就是因为不扫事件）。
 * 簇的 lastSeenAt 已经携带了新鲜度，用它做衰减是等价且零成本的近似。
 *
 * 返回 null = 没有任何可用质心 → 调用方传 null → 该维度权重重分配。
 */
export function recentBehaviorCentroid(
  clusters: readonly CentroidSource[],
  now: Date = new Date()
): number[] | null {
  const acc: number[] = []
  let totalWeight = 0
  for (const c of clusters) {
    if (!c.centroid?.length) continue
    const ageDays = Math.max(
      0,
      (now.getTime() - Date.parse(c.lastSeenAt)) / 86_400_000
    )
    if (!Number.isFinite(ageDays)) continue
    // 指数衰减：21 天半衰期 —— 两个月前的方向只剩约 1/8 的话语权
    const decay = Math.pow(0.5, ageDays / RECENT_BEHAVIOR_HALF_LIFE_DAYS)
    const w = Math.max(0, c.weight) * decay
    if (w <= 0) continue
    for (let i = 0; i < c.centroid.length; i++) {
      acc[i] = (acc[i] ?? 0) + c.centroid[i] * w
    }
    totalWeight += w
  }
  if (!totalWeight) return null
  return acc.map((v) => v / totalWeight)
}

/**
 * 候选与近期质心的相似度。
 *
 * 返回 null 的唯一情形是「整批都算不出」（没有质心）——那时全体一致地走权重重分配。
 * 单张候选没有向量（S6 知识卡、无 embedding 的市场卡）时给中性值：
 * 让它缺席会触发重分配，于是同批里有的卡按 7 维算、有的按 6 维算，
 * 分数不再可比，排序失真。宁可给一个中性的"不知道"，也不要换一把尺子。
 */
export function recentSimilarityOf(
  candidateEmbedding: number[] | null,
  centroid: number[] | null
): number | null {
  if (!centroid?.length) return null
  if (!candidateEmbedding?.length) return RECENCY_NO_SIGNAL_SIM
  if (candidateEmbedding.length !== centroid.length) return RECENCY_NO_SIGNAL_SIM
  return cosineSimilarity(candidateEmbedding, centroid)
}

// ──────────────────────────────────────────────────────────
// v3：口味惩罚求值（簇级 × 槽位级，取更严的一个）
// ──────────────────────────────────────────────────────────

export interface TasteEntry {
  /** 簇级乘子（来自 ✕ 原因） */
  penalty: number
  /** ✕ 原因码；null=未选原因（不参与槽位级约束） */
  reason: DismissReasonCode | null
}

/**
 * 把「这个方向被 ✕ 过」落到具体一张卡上：簇级乘子与槽位级约束取更严的一个。
 *
 * 为什么不叠加：叠加会让被 ✕ 过的方向彻底消失（0.75×0.6=0.45 已经够狠），
 * 而推荐必须给创作者留一点"也许是我判断错了"的余地。
 */
export function tasteFactorFor(
  entry: TasteEntry | undefined,
  slot: SuggestionSlot
): number {
  if (!entry) return 1
  const slotPenalty = entry.reason
    ? TASTE_SLOT_PENALTY[entry.reason]?.[slot] ?? 1
    : 1
  return Math.min(entry.penalty, slotPenalty)
}

// ──────────────────────────────────────────────────────────
// 分槽选择（API 用）
// ──────────────────────────────────────────────────────────

export type SuggestionSlot = 'core_gap' | 'evidence_followup' | 'exploration' | 'continuation'

export interface SlotRow {
  id: string
  clusterCode: string | null
  slot: SuggestionSlot
  score: number
  title: string
  description: string
  topic: string
  formHint: string
  scoreBreakdown: Record<string, number>
  evidence: Record<string, unknown>
  marketFlags: Record<string, unknown>
  // WF6：AI 预制理由（selectSlots 纯透传，不参与分槽逻辑）
  coreQuestion: string | null
  whyRecommend: string | null
  creationAngle: string | null
  relatedKnowledge: string[]
  reasonSource: string
}

export interface SelectSlotsOptions {
  /** 用户最强 core 簇的 weight（用于自适应同簇配额） */
  maxCoreWeight: number
  /** 选多少张；默认 3 */
  count?: number
  /** 注入日种子（测试用）；默认取当天日期 */
  seed?: string
}

/**
 * 从 active 推荐卡队列中按分槽配额选 N 张：
 *   A=core_gap         ≥1 张（用户最熟悉的方向缺口）
 *   B=evidence_followup ≥1 张（已关注但未兑现）
 *   C=exploration      0-1 张（探索性，自适应）
 *   D=continuation     0-1 张（当前项目延续）
 *
 * 自适应：core 簇 weight≥0.8 时允许同簇 2 张（仍受总分上限约束）。
 */
export function selectSlots(rows: SlotRow[], options: SelectSlotsOptions): SlotRow[] {
  const targetCount = options.count ?? 3
  if (!rows.length) return []
  if (rows.length <= targetCount) return stableOrder(rows, options.seed)

  const maxPerCluster = options.maxCoreWeight >= CORE_WEIGHT_ALLOW_DUP_THRESHOLD ? 2 : 1

  // 按槽位分桶
  const buckets: Record<SuggestionSlot, SlotRow[]> = {
    core_gap: [],
    evidence_followup: [],
    exploration: [],
    continuation: [],
  }
  for (const r of rows) {
    if (buckets[r.slot]) buckets[r.slot].push(r)
  }
  // 每个桶内按 score 倒序 + 日种子稳定打散
  for (const k of Object.keys(buckets) as SuggestionSlot[]) {
    buckets[k] = stableOrder(buckets[k], options.seed)
  }

  const picked: SlotRow[] = []
  const clusterCount = new Map<string, number>()

  function clusterReachedMax(r: SlotRow): boolean {
    if (!r.clusterCode) return false
    return (clusterCount.get(r.clusterCode) ?? 0) >= maxPerCluster
  }

  function takeOne(slot: SuggestionSlot, max = 1) {
    let taken = 0
    for (const r of buckets[slot]) {
      if (taken >= max) break
      if (picked.some((p) => p.id === r.id)) continue
      if (clusterReachedMax(r)) continue
      picked.push(r)
      if (r.clusterCode) clusterCount.set(r.clusterCode, (clusterCount.get(r.clusterCode) ?? 0) + 1)
      taken++
    }
  }

  // 第一轮：每槽取 1 张保证多样性
  takeOne('core_gap', 1)
  takeOne('evidence_followup', 1)
  takeOne('continuation', 1)
  takeOne('exploration', 1)

  // 优先级补齐：core_gap → evidence_followup → exploration → continuation
  // 探索新选题优先于旧项目延续——灵感页的核心职责是"发现写什么新内容"
  const priority: SuggestionSlot[] = ['core_gap', 'evidence_followup', 'exploration', 'continuation']
  while (picked.length < targetCount) {
    const beforeLen = picked.length
    for (const slot of priority) {
      if (picked.length >= targetCount) break
      takeOne(slot, 1)
      if (picked.length > beforeLen) break
    }
    if (picked.length === beforeLen) break // 没有可用候选
  }

  // 仍不够 N 张：从所有桶按 score 补（不再考虑同簇配额）
  if (picked.length < targetCount) {
    const used = new Set(picked.map((p) => p.id))
    const flat = stableOrder(rows.filter((r) => !used.has(r.id)), options.seed)
    for (const r of flat) {
      if (picked.length >= targetCount) break
      picked.push(r)
    }
  }

  return picked.slice(0, targetCount)
}

// ──────────────────────────────────────────────────────────
// 日种子稳定排序（纯函数，无外部依赖）
// ──────────────────────────────────────────────────────────

/** 默认日种子：YYYY-MM-DD，同日稳定（WF0 起导出，供降级模板等复用） */
export function dailySeed(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** mulberry32：给定种子的确定性 PRNG，返回 [0,1) */
export function mulberry32(seedStr: string): () => number {
  let h = 1779033703 ^ seedStr.length
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 按 score 倒序，同分区间内用日种子确定性打散。
 * - 不同 score 不受种子影响（保证 Top 候选稳定）
 * - 同分候选跨日轮换（避免用户每次刷新看到完全相同的顺序）
 *
 * 实现：先按 jitter 排序，再用 score 倒序做稳定排序。
 * V8 的 TimSort 在后一轮保持相同 score 的相对顺序，
 * 等价于"桶间严格按 score、桶内按 jitter"。
 */
function stableOrder<T extends { score: number; id: string }>(arr: T[], seed?: string): T[] {
  if (arr.length <= 1) return [...arr]
  const rng = mulberry32(seed ?? dailySeed())

  // 第一轮：按 jitter 倒序
  const tagged = arr.map((x) => ({
    item: x,
    jitter: rng(), // [0,1)
  }))
  tagged.sort((a, b) => b.jitter - a.jitter)

  // 第二轮：按 score 倒序，依赖 TimSort 稳定性保持同分顺序
  tagged.sort((a, b) => {
    if (Math.abs(b.item.score - a.item.score) < 0.0001) {
      // 完全相同时 fallback 到 id（避免不必要的位置抖动）
      return a.item.id.localeCompare(b.item.id)
    }
    return b.item.score - a.item.score
  })

  return tagged.map((t) => t.item)
}
