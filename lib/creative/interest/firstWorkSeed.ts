// ============================================================
// 首篇创作引导卡（行为B）
//
// 问题：scoreClusters 的单成员正向簇会被 CLUSTER_MIN_MEMBERS=2 全部滤掉，
// 用户完成第 1 篇创作后 scored 为空 → builder 写空画像 + 零推荐卡，
// 必须攒到 5 个事件且有 2 个同主题事件才能看到个性化内容。
//
// 策略（最小侵入，不改聚类/评分口径）：
//   scored 为空但 allScored 中存在"孤立的非负子簇"时，取最近一次创作做种子，
//   复用 S4 exploration LLM 产 1 个相邻方向（prompt 本身要求不重复种子方向），
//   落 1 张 slot=exploration / cluster_code=no_cluster 的引导卡。
//   不建 interest_clusters 行（孤立行为不构成"兴趣方向"，不污染画像分层）；
//   下次 build 正常成簇时本卡随 supersedeExceptBuild 自然退场（按 build_id 排除）。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScoredCluster } from './scoring'
import type { EngineEvent } from './types'
import type { Candidate } from './candidates'
import { hardFilter, embedCandidates } from './candidates'
import { getExplorationCandidates } from './suggestionSynthesizer'
import { generateEmbedding } from '@/lib/storage'
import { scoreCandidate } from './ranking'
import { buildRankingFeatures } from './rescore'
import { generateAiReasons } from './reasonAi'
import { insertSuggestions, type SuggestionInsertInput } from './suggestionRepo'
import { cosineSimilarity } from './vectorMath'

/**
 * 从全部评分子簇（含被 MIN_MEMBERS 滤掉的单成员簇）中选首篇种子：
 * 非负 + 至少 1 个成员，取 lastSeenAt 最新（= 用户最近一次创作行为）。
 */
export function pickFirstWorkSeed(allScored: ScoredCluster[]): ScoredCluster | null {
  const seeds = allScored
    .filter((c) => !c.isNegative && c.eventCount >= 1 && c.members.length >= 1)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
  return seeds[0] ?? null
}

/** 种子簇 → S4 exploration LLM 的种子描述；成员均无 topic 摘录时返回 null。 */
export function toExplorationSeed(
  seed: ScoredCluster
): { label: string; summary: string; keywords: string[] } | null {
  // 取发生时间最新的成员主题（单成员簇就是它自己；多成员被滤场景取最新）
  const latest = [...seed.members].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0]
  const topic = ((latest as EngineEvent & { _topic?: string })?._topic ?? '').trim()
  if (!topic) return null
  const label = topic.slice(0, 40)
  return {
    label,
    summary: `用户刚创作了「${label}」，想找相邻但不重复的创作方向`,
    keywords: [],
  }
}

/**
 * 候选 → 引导卡落库行（确定性部分；评分无簇可依，走 exploration 语义地板分）。
 * evidence 打 first_work_seed 标记，供后续分析区分这类卡与正常探索卡。
 */
export function buildSeedSuggestionInput(
  cand: Candidate,
  seedLabel: string,
  now: Date = new Date()
): SuggestionInsertInput {
  // 无匹配簇：semanticSimilarity=null + exploration source → ranking 给探索地板分；
  // 标签维度无 tag_embedding 可比对，兜底 1（与 builder 步骤 14 同口径）
  const scored = scoreCandidate({
    candidate: cand,
    semanticSimilarity: null,
    trend: null,
    daysSinceLastInCluster: 0,
    tagOverlapRatio: 1,
  })

  return {
    clusterCode: 'no_cluster',
    slot: 'exploration',
    source: 'exploration',
    title: cand.title,
    description: cand.description,
    topic: cand.topic,
    formHint: cand.formHint,
    score: scored.score,
    scoreBreakdown: scored.breakdown,
    // RULE v5：与 builder/refill 同口径落特征。这里 knowledge 固定 null——
    // 引导卡出现在用户第一篇刚写完时，彼时尚无可用知识单元。
    embedding: cand.embedding,
    rankingFeatures: buildRankingFeatures({
      quality: cand.contentValue,
      tagOverlap: 1,
      knowledge: null,
    }),
    evidence: {
      first_work_seed: true,
      seed_topic: seedLabel,
      facts: [{ type: 'create', count: 1 }],
      source: 'exploration',
      gap_reason: `基于你刚创作的「${seedLabel}」延伸的相邻方向`,
      generated_at: now.toISOString(),
    },
  }
}

/**
 * 编排：选种子 → LLM 相邻方向 → 过滤复述种子主题的候选 → AI 理由（失败模板降级）→ 落 1 张卡。
 * 任何一环失败/为空都返回 0 且不抛（builder 主流程继续写空画像，行为与改造前一致）。
 */
export async function buildFirstWorkSeedCard(
  supabase: SupabaseClient,
  userId: string,
  buildId: string,
  allScored: ScoredCluster[],
  now: Date = new Date()
): Promise<number> {
  const seed = pickFirstWorkSeed(allScored)
  if (!seed) return 0
  const seedInput = toExplorationSeed(seed)
  if (!seedInput) return 0

  let candidates: Candidate[] = []
  try {
    candidates = await getExplorationCandidates([seedInput], [])
  } catch (e) {
    console.warn('[interest] 首篇引导卡：探索候选生成失败:', e instanceof Error ? e.message : e)
    return 0
  }

  // RULE v5：探索候选同样不带向量（S4 硬编码 null）。不补上，下面两处
  // 依赖向量的逻辑都是死的：hardFilter 会放行"LLM 复述刚写主题"的卡，
  // 而"取与种子最接近的一张"会退化成取首张（全部 -1，排序无效）。
  await embedCandidates(candidates, (t) => generateEmbedding(t))

  // 用种子成员自身向量过滤"LLM 复述了刚写主题"的候选（阈值同 hardFilter 已写过 0.85）
  const seedEmbeddings = seed.members
    .map((m) => (Array.isArray(m.embedding) ? (m.embedding as number[]) : null))
    .filter((v): v is number[] => !!v && v.length === 1024)
  const filtered = hardFilter(candidates, seedEmbeddings, [], [])
  if (!filtered.length) return 0

  // 多个候选时取与种子语义最接近的（"相邻"而非"随机"）；无向量可比则取首张
  const cand = [...filtered].sort((a, b) => {
    const sa = a.embedding && seed.centroid.length ? cosineSimilarity(a.embedding, seed.centroid) : -1
    const sb = b.embedding && seed.centroid.length ? cosineSimilarity(b.embedding, seed.centroid) : -1
    return sb - sa
  })[0]

  const item = buildSeedSuggestionInput(cand, seedInput.label, now)

  // AI 理由：facts 非空（1 次 create）满足 reasonAi 送 AI 红线；失败逐条模板降级，卡不丢
  try {
    const [reason] = await generateAiReasons([
      {
        title: item.title,
        clusterLabel: seedInput.label,
        facts: item.evidence.facts as Array<Record<string, unknown>>,
        gapReason: (item.evidence.gap_reason as string) ?? null,
        materialTitles: [],
      },
    ])
    if (reason) {
      item.coreQuestion = reason.coreQuestion
      item.whyRecommend = reason.whyRecommend
      item.creationAngle = reason.creationAngle
      item.relatedKnowledge = reason.relatedKnowledge
      item.reasonSource = reason.reasonSource
    }
  } catch (e) {
    console.warn('[interest] 首篇引导卡：AI 理由生成失败，用模板降级:', e instanceof Error ? e.message : e)
  }

  return insertSuggestions(supabase, userId, buildId, [item])
}
