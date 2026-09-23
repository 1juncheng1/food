// ============================================================
// Creator Interest Profile —— S2/S4 候选合成（需 service role + LLM）
//
// 与 candidates.ts 的边界：
//   candidates.ts 只做用户私有数据取数（S1/S3/S5，user token 即可）
//   synthesizer 做：
//     S2 ci_market     —— service role 读 ci_items（跨用户共享，仅服务端）
//     S4 exploration   —— LLM 基于用户 core 簇生成 1-2 个探索方向
//     LLM 包装         —— 给 ci_market 候选补 title/description/价值分
//
// 设计红线：
//   1. ci_items.query_hash / ai_analysis 不返回前端（仅 synthesizer 内部消费）
//   2. 候选晋升为推荐卡前必须脱敏：只保留 title/topic/url/platform
//   3. LLM 失败降级：不阻塞 build，跳过该来源候选
// ============================================================

import { getServiceClient } from '../../ci/store'
import { ciItemToExternalTrend } from '../../ci/protocol'
import type { CIPlatform } from '../../ci/types'
import { cosineSimilarity } from './vectorMath'
import type { Candidate } from './candidates'
import { cleanTopicExcerpt } from './normalize'
import { llmTimeoutSignal } from '@/lib/llm'
import type { InterestLayer } from './types'
import { EXPLORATION_MAX_SEEDS } from './config'

// ──────────────────────────────────────────────────────────
// S2: ci_market —— 从市场情报库检索与用户核心簇相近的条目
// ──────────────────────────────────────────────────────────

/**
 * 用 service role 检索 ci_items，应用端做相似度排序。
 *
 * 实现：取近 30 天 fetched_at 倒序 Top 200（已过滤未过期），
 *      应用端用 cosineSimilarity 与 userCentroid 计算，取 Top N。
 *
 * 性能权衡：ci_items 表预期规模 ≤ 10K，Top 200 + 应用端过滤足够。
 * 若后续规模扩大，应在 setup.sql 补 match_ci_items RPC（用 HNSW 索引）。
 */
export async function getMarketCandidates(
  userCentroid: number[] | null,
  limit = 4
): Promise<Candidate[]> {
  if (!userCentroid?.length) return []

  const db = getServiceClient()
  if (!db) return [] // 未配置 service role key，静默降级

  try {
    const since = new Date()
    since.setDate(since.getDate() - 30)
    const { data, error } = await db
      .from('ci_items')
      .select('id, platform, external_id, url, title, excerpt, ai_analysis, embedding, fetched_at, expires_at')
      .gt('expires_at', new Date().toISOString())
      .gte('fetched_at', since.toISOString())
      .order('fetched_at', { ascending: false })
      .limit(200)

    if (error || !data?.length) return []

    // 应用端相似度排序
    const scored = data
      .map((r) => {
        const emb = Array.isArray(r.embedding) ? (r.embedding as number[]) : null
        if (!emb || emb.length !== userCentroid.length) return null
        return { r, sim: cosineSimilarity(emb, userCentroid) }
      })
      .filter((x): x is { r: typeof data[number]; sim: number } => x !== null)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, limit)

    const out: Candidate[] = []
    for (const { r, sim } of scored) {
      // WF8：S2 出口统一经 ExternalTrendData 协议转换——未来外部平台源
      // （抖音/B站/知乎）共用此出口，消费方（Candidate 组装）零感知平台差异
      const trend = ciItemToExternalTrend({
        platform: (r.platform as CIPlatform) ?? 'web_search',
        external_id: String(r.external_id ?? ''),
        url: r.url ? String(r.url) : '',
        title: String(r.title ?? ''),
        excerpt: String(r.excerpt ?? ''),
        fetched_at: String(r.fetched_at ?? ''),
      })
      const aiAnalysis = (r.ai_analysis as Record<string, unknown> | null) ?? null
      const coreView = (aiAnalysis?.core_viewpoint as string) ?? ''
      const refValue = (aiAnalysis?.reference_value as string) ?? ''

      // 价值分：相似度 ×0.6 + ai_analysis 参考价值提示 ×0.4
      // 没有参考价值的条目降一档（避免推 LLM 未评估的原始市场数据）
      const hasAiHint = coreView || refValue
      const contentValue = Math.max(0.3, Math.min(0.85, sim * 0.6 + (hasAiHint ? 0.4 : 0.2)))

      const topic = cleanTopicExcerpt(trend.title || trend.excerpt) || trend.title
      const url = trend.url
      const platform = trend.platform

      out.push({
        source: 'ci_market',
        slot: 'core_gap',
        title: trend.title || '市场参考选题',
        description: trend.excerpt || coreView || '来自平台市场情报',
        topic,
        formHint: '其他',
        embedding: null, // ci_items 的 embedding 不外泄到队列
        clusterCode: null,
        contentValue,
        marketRefs: url ? [{ platform, url }] : null,
      })
    }
    return out
  } catch (e) {
    console.error('[interest] S2 ci_market 取数失败:', e)
    return []
  }
}

// ──────────────────────────────────────────────────────────
// S4: exploration —— LLM 基于 core 簇生成探索方向
// ──────────────────────────────────────────────────────────

export interface ExplorationSeed {
  label: string
  summary: string
  keywords: string[]
  /** WF11 P1：该种子由两个兴趣簇融合而成（跨簇探索），LLM 需产出跨界选题并回射 seed_type */
  cross?: boolean
}

/** buildExplorationSeeds 的最小入参：ClusterView 中与种子构造相关的字段子集 */
export interface ExplorationSeedView {
  clusterId: string
  code: string
  label: string
  summary: string
  keywords: string[]
  layer: InterestLayer
  weight: number
  isNegative: boolean
}

export interface BuildSeedsResult {
  /** 单簇种子在前、跨簇组合追加在后，可直接喂给 getExplorationCandidates */
  seeds: ExplorationSeed[]
  /** 未成为单簇种子的簇 label（含负簇，沿用旧 builder 口径），喂 prompt 做去重 */
  nonCoreLabels: string[]
  /**
   * 入选的单簇视图（同 seeds 中 non-cross 的顺序）。
   * builder 用 seedClusters[0].clusterId 把 S4 首张单簇卡强制绑定到最强簇（core_gap 证据链）。
   */
  seedClusters: ExplorationSeedView[]
}

/**
 * WF11 P1：从画像簇构造多兴趣探索种子。
 *
 * 计算口径：
 *   1. 候选池 = 非负簇（isNegative 的簇永不喂给探索生成，避免把"明确不喜欢"当方向）
 *   2. 排序 = core 层优先，同层按 weight 降序，再以 code 字典序兜底（保证 build 可复现）
 *   3. 单簇种子 = 排序后前 EXPLORATION_MAX_SEEDS（默认 6）个
 *   4. 跨簇组合 = 最强的前两个单簇种子额外融合成 1 条（不占 6 名额）；
 *      不足 2 个非负簇时不产生组合。
 *      跨簇组合是"抖音式多兴趣"的核心：让推荐跨越单一画像维度。
 */
export function buildExplorationSeeds(
  views: ExplorationSeedView[],
  maxSeeds: number = EXPLORATION_MAX_SEEDS
): BuildSeedsResult {
  const layerRank = (layer: InterestLayer) => (layer === 'core' ? 0 : 1)
  const eligible = views
    .filter((v) => !v.isNegative)
    .slice()
    .sort((a, b) => {
      // 排序口径 = 层优先级升序（core=0）→ weight 降序 → code 字典序
      if (layerRank(a.layer) !== layerRank(b.layer)) return layerRank(a.layer) - layerRank(b.layer)
      if (a.weight !== b.weight) return b.weight - a.weight
      return a.code < b.code ? -1 : a.code > b.code ? 1 : 0
    })

  const chosen = eligible.slice(0, maxSeeds)
  const singleSeeds: ExplorationSeed[] = chosen.map((v) => ({
    label: v.label,
    summary: v.summary,
    keywords: v.keywords.slice(0, 4),
  }))

  // 跨簇组合关键词 = 两簇关键词按出现顺序并集去重，取前 6（控制 prompt 长度）
  const combos: ExplorationSeed[] = []
  if (chosen.length >= 2) {
    const [a, b] = chosen
    const merged: string[] = []
    for (const kw of [...a.keywords, ...b.keywords]) {
      if (!merged.includes(kw)) merged.push(kw)
    }
    combos.push({
      label: `「${a.label}」×「${b.label}」`,
      summary: `融合${a.label}与${b.label}两个方向的跨界创作角度：${a.summary}；${b.summary}`,
      keywords: merged.slice(0, 6),
      cross: true,
    })
  }

  const chosenCodes = new Set(chosen.map((v) => v.code))
  // 未入选 label 保持 views 原始顺序（与旧 builder 的 filter 口径一致，便于 prompt 稳定 diff）
  const nonCoreLabels = views.filter((v) => !chosenCodes.has(v.code)).map((v) => v.label)

  return { seeds: [...singleSeeds, ...combos], nonCoreLabels, seedClusters: chosen }
}

interface LlmExplorationItem {
  title: string
  description: string
  topic: string
  content_value: number // LLM 估 0-1，作 hint
  /** WF11 P1：LLM 对每个选题回射来源类型，"cross"=来自跨簇融合种子 */
  seed_type?: string
  /** WF11 P1：LLM 回射的来源种子方向名（必须原样复制输入中的某个方向名） */
  seed_label?: string
}

/** S4 默认产出条数：首篇作品引导等轻量路径保持旧行为（2 条） */
const EXPLORATION_DEFAULT_COUNT = 2

/**
 * 系统提示词按目标条数参数化（WF11 P1：2 → 16 批量供给）。
 * hasCross=true 时追加跨簇融合的输出约束并要求回射 seed_type。
 */
function buildSystemPrompt(count: number, hasCross: boolean): string {
  const lines = [
    `你是创作者兴趣探索分析师。给你用户的多个核心兴趣方向，生成 ${count} 个相邻但不重叠的探索方向。`,
    '硬性要求：',
    '1. 必须与用户既有方向有语义关联（让用户能识别"哦，这个我可以试试"），但角度要差异化',
    '2. 不能直接复述用户输入——要给出新的切入点、视角、受众、或场景',
    '3. 禁止生成与用户方向完全无关的"随机选题"，那样会让推荐失去信任',
    '4. 禁止空洞方向（如"写一篇情感共鸣文"），必须有具体可写的选题',
    '5. content_value ∈ [0,1]：你对这个方向创作价值的估计，参考你的市场经验',
    `6. 输出条数必须恰好为 ${count} 条，覆盖不同输入方向，不要扎堆在同一个方向`,
  ]
  if (hasCross) {
    lines.push(
      '7. 输入中标注 [融合方向] 的种子是两个方向的交叉点：必须至少为它产出 1 个真正融合两者的选题',
    )
  }
  lines.push(
    '',
    '输出一个 JSON 对象，格式为 {"explorations": [ ... ]}，数组中每元素含：',
    '- title: 选题标题（≤40 字）',
    '- description: 一句话说明这个方向的价值和切入角度（≤80 字）',
    '- topic: 适合喂给生成模型的具体主题词（≤60 字，不含修饰语）',
    '- content_value: 0-1 浮点数',
    // seed_type 回射是 cross_exploration 证据链的唯一来源，缺它则跨簇卡无法被标记
    '- seed_type: "single" 表示来自单一方向种子；"cross" 表示来自 [融合方向] 种子',
    // seed_label 让单簇探索卡在落库时能关联回来源簇（facts/理由覆盖 + 多簇覆盖可观测）
    '- seed_label: 该选题来源方向的名称，必须从上面输入的"方向：XXX"中原样复制一个；cross 选题填融合种子名称',
    '',
    '只输出 JSON 对象，不要 markdown 代码块或任何解释。',
  )
  return lines.join('\n')
}

/**
 * 用 LLM 生成探索方向。
 * 失败/降级时返回空数组，不阻塞 build。
 *
 * WF11 P1：新增 opts.count（默认 2，首篇引导路径不回归；builder 主路径传 16 扩批）。
 */
export async function getExplorationCandidates(
  seeds: ExplorationSeed[],
  existingClusterLabels: string[] = [],
  opts?: { count?: number }
): Promise<Candidate[]> {
  // 目标产出条数 = 调用方显式传入值，缺省 2（旧行为）；非正整数防御为默认值
  const count = opts && Number.isInteger(opts.count) && (opts.count as number) > 0
    ? (opts.count as number)
    : EXPLORATION_DEFAULT_COUNT
  if (!seeds.length) return []
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('[interest] DEEPSEEK_API_KEY 未配置，跳过 S4 exploration')
    return []
  }

  // 输入中是否含跨簇融合种子：决定 prompt 是否追加融合约束
  const hasCrossSeed = seeds.some((s) => s.cross === true)

  const seedsText = seeds
    .map((s, i) => {
      const kw = s.keywords.length ? ` 关键词：${s.keywords.slice(0, 4).join('、')}` : ''
      // 融合种子加显式前缀，供系统提示词第 7 条引用
      const tag = s.cross ? '[融合方向] ' : ''
      return `[${i + 1}] ${tag}方向：${s.label}。摘要：${s.summary}${kw}`
    })
    .join('\n')

  const existingHint = existingClusterLabels.length
    ? `\n用户已有方向（避免重复）：${existingClusterLabels.join('、')}`
    : ''

  const userContent = [
    `用户核心兴趣方向：`,
    seedsText,
    existingHint,
    `\n请生成 ${count} 个探索方向，输出 JSON 对象 {"explorations":[...]}。`,
  ].join('\n')

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: llmTimeoutSignal(1200),
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: buildSystemPrompt(count, hasCrossSeed) },
          { role: 'user', content: userContent },
        ],
        temperature: 0.6,
        // token 预算口径 = 每条选题约 170 token（16 条实测 2600 的均值）。
        // 批量条数 >2 时按公式给；2 条旧路径维持 700。
        // DeepSeek max_tokens 上限 8192，24 条需 4080，安全。
        max_tokens: count > 2 ? count * 170 : 700,
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      console.error('[interest] S4 exploration LLM 失败:', await res.text())
      return []
    }

    const data = await res.json()
    const text: string = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) return []

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const parsed = JSON.parse(cleaned)

    // response_format json_object 模式下，数组会被包成 { items: [...] } 或直接 [...]，
    // 兼容三种形式
    const items: LlmExplorationItem[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.explorations)
          ? parsed.explorations
          : []

    const out: Candidate[] = []
    for (const it of items) {
      const title = String(it.title ?? '').trim().slice(0, 40)
      const description = String(it.description ?? '').trim().slice(0, 120)
      const topic = String(it.topic ?? title).trim().slice(0, 200)
      if (!title || !topic) continue

      const cv = Math.max(0, Math.min(1, Number(it.content_value) || 0.5))
      // 跨簇标记口径：仅当 LLM 明确回射 seed_type="cross" 时置 true；
      // single/缺省/其他值一律不标记（不信任模型对普通种子的跨界自述）
      const isCross = String(it.seed_type ?? '').trim() === 'cross'
      // seed_label 原样保留（trim 但不改写）；builder 只在精确命名单簇种子时才采信
      const seedLabel = String(it.seed_label ?? '').trim()
      out.push({
        source: 'exploration',
        slot: 'exploration',
        title,
        description,
        topic,
        formHint: '其他',
        embedding: null,
        clusterCode: null,
        contentValue: cv,
        marketRefs: null,
        ...(isCross ? { crossSeed: true } : {}),
        ...(seedLabel ? { seedLabel } : {}),
      })
    }
    return out.slice(0, count)
  } catch (e) {
    console.error('[interest] S4 exploration 异常:', e)
    return []
  }
}

// ──────────────────────────────────────────────────────────
// 工具：从用户画像取最强 core 簇质心（供 S2/S4 用）
// ──────────────────────────────────────────────────────────

/**
 * 从画像 jsonb 取最强 core 簇的 cluster_id。
 * builder 调用：用这个 id 查 interest_clusters 表拿 centroid。
 */
export function pickTopCoreClusterId(profile: Record<string, unknown> | null): string | null {
  if (!profile) return null
  const core = profile.core as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(core) || !core.length) return null
  const top = core[0]
  const id = top?.cluster_id
  return typeof id === 'string' ? id : null
}
