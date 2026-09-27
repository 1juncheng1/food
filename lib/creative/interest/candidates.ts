// ============================================================
// Creator Interest Profile —— 候选生成 + 硬过滤
// S1/S3/S5 取数 + hardFilter 纯函数；S2/S4 在 synthesizer 做
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { cosineSimilarity } from './vectorMath'
import {
  isUnitInjectable,
  normalizeKnowledgeUnit,
  type CreatorKnowledgeUnit,
} from '../knowledgeUnit'

export interface Candidate {
  source:
    | 'own_inspiration'
    | 'ci_market'
    | 'saved_material'
    | 'exploration'
    | 'active_project'
    /** P1：creator_knowledge（用户已确认的跨素材知识单元）驱动的选题 */
    | 'creator_knowledge'
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
  /**
   * P1：显式指定所属簇（cluster_code），作为簇匹配的最后一级。
   *
   * 存在理由：creator_knowledge 表没有 embedding 列，S6 候选拿不到向量，
   * 既有的"embedding 余弦兜底"对它永远失效 → 卡会落到无簇分支，facts 为空、
   * AI 理由走模板、推荐说不出"为什么是你"。知识单元自带 domain_scope
   * （与簇 keywords 同源的受控词表），可以靠文本重叠直接命中簇。
   *
   * 与 seedLabel 的区别：seedLabel 由 LLM 回射、可能改写而命中失败；
   * 这是确定性匹配，命中即生效。
   */
  forceClusterCode?: string | null
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

// ── 候选向量化 ──

/** bge-m3 输出维度，与 config.EMBEDDING_MODEL 声明的 1024 对齐 */
const EMBEDDING_DIM = 1024

/**
 * 候选的向量化文本：title + topic，**刻意不含 description**。
 *
 * description 在 S1/S2/S3 里是「你分析过这个主题，价值分 8/10」这类元信息，
 * 把它混进向量只会稀释方向信号。可比性才是这里的全部要求：簇质心由事件 topic
 * 的嵌入均值而来，已写过的向量也来自 work_generate 的 topic——候选必须用
 * 同一种文本（"这张卡在讲什么方向"）才能和它们放在同一空间里比。
 */
export function candidateEmbedText(c: Pick<Candidate, 'title' | 'topic'>): string {
  return [c.title, c.topic]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join(' ')
    .trim()
    .slice(0, 8000)
}

/**
 * 给缺失向量的候选补 embedding（就地写入，返回补上的条数）。
 *
 * 为什么必须有这一步：S4（LLM 生成）与 S6（知识单元）产出的候选 embedding
 * 恒为 null，S2 也刻意不外泄 ci_items 的原始向量。而队列里绝大多数卡来自 S4。
 * 没有向量的候选会同时让三件事失效：
 *   1. hardFilter 的「已写过 / 已 ✕ / 队列内」三重查重 —— 它遇到 null 直接放行
 *   2. 候选 → 簇的余弦匹配 —— 全部落到 no_cluster，兴趣画像无从参与排序
 *   3. 语义相似度 / 近期行为 / 标签命中三个评分子项 —— 恒为兜底值
 * 也就是说在补上这一步之前，排序链路对绝大多数卡是断的。
 *
 * 就地修改而非返回新数组：builder 用 WeakMap（forceBind）以候选对象引用为键，
 * 换对象会让显式绑簇的引用查不到。
 *
 * 失败语义：embedFn 返回 null 或抛错 → 该条保持原状（null），其余照常。
 * 拿不到向量只退回今天之前的行为，不能让 build 失败。
 */
export async function embedCandidates(
  candidates: Candidate[],
  embedFn: (text: string) => Promise<number[] | null>,
  concurrency = 6
): Promise<number> {
  const missing = candidates.filter(
    (c) => !Array.isArray(c.embedding) || c.embedding.length !== EMBEDDING_DIM
  )
  if (!missing.length) return 0

  let cursor = 0
  let done = 0
  const worker = async (): Promise<void> => {
    while (cursor < missing.length) {
      const i = cursor++
      const c = missing[i]
      const text = candidateEmbedText(c)
      if (!text) continue
      try {
        const vec = await embedFn(text)
        if (Array.isArray(vec) && vec.length === EMBEDDING_DIM) {
          c.embedding = vec
          done++
        }
      } catch (e) {
        console.warn(
          '[candidates] 候选向量化失败:',
          e instanceof Error ? e.message : String(e)
        )
      }
    }
  }
  const lanes = Math.min(Math.max(concurrency, 1), missing.length)
  await Promise.all(Array.from({ length: lanes }, worker))
  return done
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

// ── S6: 已确认的知识单元（Creator Knowledge System → 推荐选题）──
//
// 为什么必须补这一路：creator_knowledge 是用户亲手确认过的跨素材知识，
// 信息密度远高于"又浏览了一次"，但它此前在推荐侧零引用——用户沉淀的知识
// 从来没变成过选题。这是"已建未接"最典型的一处。
//
// 设计取舍：
//   1. 只取 isUnitInjectable 的单元（status=已确认 且 confidence≥0.6）。
//      候选态的 AI 归纳未经用户确认，拿它去生成推荐等于替用户做主——
//      与 knowledgeUnit.ts「候选不进 Prompt 注入」同一条授权链。
//   2. 不调 LLM。知识单元本身就是可引用的完整命题（claim 写成句子），
//      直接转成选题卡即可；为"再润色一下"多花一次 LLM 不划算，
//      而且会把确定性事实包变成不确定的生成文本。
//   3. 无 embedding 可用，因此靠 domain_scope × 簇 keywords 的文本重叠
//      命中簇（forceClusterCode），保证卡能带上真实行为事实。

/** 簇的文本标签（S6 匹配用最小集） */
export interface KnowledgeClusterHint {
  code: string
  label: string
  keywords: string[]
}

/** S6 最多产出条数：与 S1(3)/S3(2) 同量级，避免知识库大的用户刷屏 */
const KNOWLEDGE_CANDIDATE_LIMIT = 3

/**
 * domain_scope × 簇文本的确定性匹配。
 * 双向包含（scope ⊇ kw 或 kw ⊇ scope）而非全等：受控词表存在粒度差异
 * （簇关键词"AI 创业" vs scope"AI"），全等会把大量有效命中判丢。
 */
export function matchKnowledgeCluster(
  domainScope: string[],
  clusters: KnowledgeClusterHint[]
): string | null {
  if (!domainScope.length) return null
  for (const c of clusters) {
    const terms = [c.label, ...c.keywords].filter(Boolean)
    for (const scope of domainScope) {
      for (const t of terms) {
        if (!t) continue
        if (scope === t || scope.includes(t) || t.includes(scope)) return c.code
      }
    }
  }
  return null
}

export async function getKnowledgeCandidates(
  supabase: SupabaseClient,
  userId: string,
  clusters: KnowledgeClusterHint[] = []
): Promise<Candidate[]> {
  const { data, error } = await supabase
    .from('creator_knowledge')
    // source_item_ids 必须选：normalizeCandidateUnit 要求 ≥2 个独立来源才承认这是
    // "跨素材归纳"而非单条素材的复制（MIN_SOURCES_FOR_UNIT），漏选会让全部单元被判空
    .select('id, user_id, concept, claim, kind, domain_scope, confidence, source_item_ids, source_count, status, created_at, updated_at, confirmed_at')
    .eq('user_id', userId)
    .eq('status', '已确认')
    .order('confidence', { ascending: false })
    .limit(30)

  if (error) {
    // 表未迁移（42703/42P01）是真实存在的部署状态，静默降级不刷错误日志
    console.warn('[interest] 知识单元读取失败，跳过 S6:', error.message)
    return []
  }
  if (!data?.length) return []

  const units = (data as unknown[])
    .map(normalizeKnowledgeUnit)
    .filter((u): u is CreatorKnowledgeUnit => !!u && isUnitInjectable(u))
    // 跨素材来源越多越可信：同等置信度下优先"归纳自更多素材"的单元
    .sort((a, b) => b.confidence - a.confidence || b.sourceCount - a.sourceCount)
    .slice(0, KNOWLEDGE_CANDIDATE_LIMIT)

  const out: Candidate[] = []
  for (const u of units) {
    const claim = u.claim.slice(0, 100)
    out.push({
      source: 'creator_knowledge',
      slot: 'evidence_followup',
      title: u.concept.slice(0, 40),
      // 诚实口径：这是用户自己确认过的知识，不是算法"猜你喜欢"
      description: `你确认过的知识：${claim}`.slice(0, 120),
      topic: u.claim.slice(0, 200),
      formHint: '其他',
      embedding: null,
      clusterCode: matchKnowledgeCluster(u.domainScope, clusters),
      forceClusterCode: matchKnowledgeCluster(u.domainScope, clusters),
      contentValue: Math.max(0, Math.min(1, u.confidence)),
      marketRefs: null,
    })
  }
  return out
}

// 知识资产覆盖度不在这里单独加载：S6 已经把知识单元取回来并做了
// domain_scope × 簇文本的确定性匹配（forceClusterCode），build 与 refill
// 直接把 S6 卡投影到簇即可，再查一次 creator_knowledge 是纯浪费。

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
