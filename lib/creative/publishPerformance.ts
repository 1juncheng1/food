// ============================================================
// Publish Performance —— 发布表现事实包（纯读取，无 UI）
//
// 存在理由：
//   「发布表现诊断」此前为零：`post_interactions` 只被 backfill 拿去反推兴趣，
//   从来没有作为"作品发布后到底怎么样"回流给创作者。而发布后的真实反馈
//   恰恰是 Creator Intelligence 最有价值的闭环 —— 它比点赞、比定稿都更接近
//   "市场是否认可这个人的表达"。
//
// 为什么先只做事实包、不做图表：
//   指标要先被验证有效，才配拿去展示。现在发布率仅 2.6%，
//   绝大多数用户只有 0~1 篇已发布作品 —— 这时候画一张"你的作品表现"
//   的图表，等于把随机噪声变成伪事实。本模块因此把**样本不足**作为一等公民：
//   样本不够就明确标注 caveat，而不是照常输出一个看似精致的排名。
//
// 设计铁律：
//   1. 纯函数 + 一个薄薄的取数函数，不写库、不调 LLM、无前端依赖。
//   2. 不做横向比较：互动量受粉丝基数、发布时间影响，只能纵向看同一用户趋势
//      （与 publicationIntent 的 DISCLAIMER 同一立场）。
//   3. 归因必须有最低样本量门槛：低于门槛只给总量事实，不给"你适合写什么"。
//   4. 只描述事实，不做建议 —— "什么值得写"是 Creation Opportunity 的职责。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

// ── 常量区（改数字 = 口径变更）──────────────────────────────

/** 置信度达到满格所需的已发布作品数 */
const CONFIDENCE_FULL_SAMPLES = 10

/** 新鲜度窗口（天）：超出视为"陈旧样本"，压低置信度 */
const FRESH_DAYS = 90

/**
 * 归因所需的最低样本量。
 * 低于这个数，只给总量事实，不给"哪个分类/标签表现更好" ——
 * 1~2 篇的平均值是噪声，不是结论。
 */
const MIN_ATTRIBUTION_SAMPLES = 3

/** 归因条目最多返回条数（观测口是给人读的，不是给机器全量灌的） */
const MAX_ATTRIBUTION_ITEMS = 5

// ── 类型 ───────────────────────────────────────────────────

/** 单篇已发布作品的表现事实 */
export interface PublishFact {
  id: string
  category: string
  tags: string[]
  likes: number
  saves: number
  comments: number
  createdAt: string
}

export interface AttributionItem {
  name: string
  samples: number
  /** 平均总互动（likes + saves + comments） */
  avgInteractions: number
}

export interface PublishPerformanceReport {
  /** 已发布作品数 */
  publishedCount: number
  totals: { likes: number; saves: number; comments: number; interactions: number }
  /** 篇均表现 */
  perPostAvg: { likes: number; saves: number; comments: number; interactions: number }
  /**
   * 保存率：saves / 总互动。
   * 保存比点赞更接近"有用"，这个比率能区分"被喜欢"和"被需要"。
   */
  saveRatio: number
  /** 评论率：comments / 总互动，反映内容是否引发讨论 */
  commentRatio: number
  /** 按分类归因（样本不足时为空数组） */
  byCategory: AttributionItem[]
  /** 按标签归因（样本不足时为空数组） */
  byTag: AttributionItem[]
  /** 表现最好的分类（样本不足时为 null） */
  bestCategory: AttributionItem | null
  /** 0~1 置信度：样本量为主、新鲜度为辅 */
  confidence: number
  /** 诚实说明：样本不足 / 无互动 / 无作品时解释"为什么结论这么少" */
  caveat: string | null
}

// ── 小工具 ─────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function round3(n: number): number {
  return Math.round(clamp01(n) * 1000) / 1000
}

function round1(n: number): number {
  return Math.round(Math.max(0, n) * 10) / 10
}

function ageDays(iso: string | undefined, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
  return (now.getTime() - t) / 86_400_000
}

function avg(total: number, count: number): number {
  return count > 0 ? round1(total / count) : 0
}

/** 按 key 分组聚合（分类与标签共用一套逻辑） */
function groupBy(
  facts: PublishFact[],
  pickKeys: (f: PublishFact) => string[]
): AttributionItem[] {
  const buckets = new Map<string, { samples: number; interactions: number }>()
  for (const f of facts) {
    const interactions = f.likes + f.saves + f.comments
    for (const key of pickKeys(f)) {
      const cur = buckets.get(key)
      if (cur) {
        cur.samples += 1
        cur.interactions += interactions
      } else {
        buckets.set(key, { samples: 1, interactions })
      }
    }
  }
  return [...buckets.entries()]
    .map(([name, v]) => ({
      name,
      samples: v.samples,
      avgInteractions: avg(v.interactions, v.samples),
    }))
    .sort((a, b) => b.avgInteractions - a.avgInteractions || b.samples - a.samples)
}

/** 只保留达到归因门槛的条目 */
function significant(items: AttributionItem[]): AttributionItem[] {
  return items
    .filter((i) => i.samples >= MIN_ATTRIBUTION_SAMPLES)
    .slice(0, MAX_ATTRIBUTION_ITEMS)
}

// ── 纯函数 ─────────────────────────────────────────────────

/**
 * 计算发布表现事实包。
 * 任何字段缺失都按 0 处理，绝不抛异常（观测口不该因为脏数据挂掉）。
 */
export function computePublishPerformance(
  facts: PublishFact[],
  now: Date = new Date()
): PublishPerformanceReport {
  const publishedCount = facts.length

  const totals = facts.reduce(
    (acc, f) => ({
      likes: acc.likes + (Number.isFinite(f.likes) ? f.likes : 0),
      saves: acc.saves + (Number.isFinite(f.saves) ? f.saves : 0),
      comments: acc.comments + (Number.isFinite(f.comments) ? f.comments : 0),
      interactions: acc.interactions,
    }),
    { likes: 0, saves: 0, comments: 0, interactions: 0 }
  )
  totals.interactions = totals.likes + totals.saves + totals.comments

  const perPostAvg = {
    likes: avg(totals.likes, publishedCount),
    saves: avg(totals.saves, publishedCount),
    comments: avg(totals.comments, publishedCount),
    interactions: avg(totals.interactions, publishedCount),
  }

  const saveRatio = totals.interactions > 0 ? round3(totals.saves / totals.interactions) : 0
  const commentRatio =
    totals.interactions > 0 ? round3(totals.comments / totals.interactions) : 0

  // 归因：必须过最低样本门槛，否则只给总量事实。
  // 零互动时即便样本够也不归因 —— 全 0 的排名没有任何信息量，
  // 照常输出只会让用户以为"随笔比 AI 教育更适合我"。
  const canAttribute = publishedCount >= MIN_ATTRIBUTION_SAMPLES && totals.interactions > 0
  const byCategory = canAttribute
    ? significant(groupBy(facts, (f) => [f.category || '未分类']))
    : []
  const byTag = canAttribute ? significant(groupBy(facts, (f) => f.tags ?? [])) : []

  // 置信度：样本量为主，新鲜度为辅（与 publicationIntent 同手法，便于对齐阅读）
  let confidence = 0
  if (publishedCount > 0) {
    const volume = Math.min(1, publishedCount / CONFIDENCE_FULL_SAMPLES)
    const freshCount = facts.filter((f) => ageDays(f.createdAt, now) <= FRESH_DAYS).length
    const freshness = freshCount / publishedCount
    confidence = round3(0.7 * volume + 0.3 * freshness)
  }

  let caveat: string | null = null
  if (publishedCount === 0) {
    caveat = '尚无任何已发布作品，无法评估发布表现。'
  } else if (publishedCount < MIN_ATTRIBUTION_SAMPLES) {
    caveat = `只有 ${publishedCount} 篇已发布作品，低于归因门槛 ${MIN_ATTRIBUTION_SAMPLES} 篇，此处只给总量事实，不给"你适合写什么"的结论。`
  } else if (totals.interactions === 0) {
    caveat = '已发布作品目前没有任何互动，无法判断表现差异。'
  } else if (byCategory.length === 0 && byTag.length === 0) {
    caveat = `没有任何分类或标签达到 ${MIN_ATTRIBUTION_SAMPLES} 篇的归因门槛，暂不做归因。`
  }

  return {
    publishedCount,
    totals,
    perPostAvg,
    saveRatio,
    commentRatio,
    byCategory,
    byTag,
    bestCategory: byCategory.length > 0 ? byCategory[0] : null,
    confidence,
    caveat,
  }
}

// ── 取数（唯一一处碰库的地方）──────────────────────────────

/**
 * 读取用户已发布作品的表现事实。
 *
 * 只取 posts 的计数列（like/save/comment 是冗余聚合列，由 RPC 维护），
 * 不 join post_interactions —— 事实包要的是结果，不是逐条明细。
 * 查库失败返回空数组：观测口不该因为读不到数据就 500。
 */
export async function fetchPublishFacts(
  supabase: SupabaseClient,
  userId: string,
  limit = 50
): Promise<PublishFact[]> {
  try {
    const { data, error } = await supabase
      .from('posts')
      .select('id, category, tags, like_count, save_count, comment_count, created_at')
      .eq('user_id', userId)
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('发布表现事实读取失败:', error.message)
      return []
    }

    return (data ?? []).map((row: Record<string, unknown>) => ({
      id: typeof row.id === 'string' ? row.id : '',
      category: typeof row.category === 'string' ? row.category : '未分类',
      tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === 'string') : [],
      likes: typeof row.like_count === 'number' ? row.like_count : 0,
      saves: typeof row.save_count === 'number' ? row.save_count : 0,
      comments: typeof row.comment_count === 'number' ? row.comment_count : 0,
      createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    }))
  } catch (e) {
    console.error('发布表现事实读取异常:', e)
    return []
  }
}
