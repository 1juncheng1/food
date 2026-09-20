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
  RANKING_WEIGHTS_V2,
  INTEREST_SEMANTIC_RATIO,
  INTEREST_TAG_RATIO,
  SEMANTIC_SIM_FLOOR,
  SEMANTIC_SIM_RANGE,
  EXPLORATION_SEMANTIC_FLOOR,
  TREND_FACTOR,
  EXPLORE_SLOT_FACTOR,
  RECENCY_LADDER,
  RECENCY_NO_EVENTS,
} from './config'

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
}

export interface CandidateScore {
  score: number
  breakdown: {
    interestMatch: number
    recentBehavior: number
    trend: number
    quality: number
    explore: number
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

  const w = RANKING_WEIGHTS_V2
  const score =
    w.interestMatch * interestMatch +
    w.recentBehavior * recentBehavior +
    w.trend * trendScore +
    w.quality * quality +
    w.explore * explore

  return {
    score: round3(clamp01(score)),
    breakdown: {
      interestMatch: round3(interestMatch),
      recentBehavior: round3(recentBehavior),
      trend: round3(trendScore),
      quality: round3(quality),
      explore: round3(explore),
    },
  }
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
