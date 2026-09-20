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
}

interface LlmExplorationItem {
  title: string
  description: string
  topic: string
  content_value: number // LLM 估 0-1，作 hint
}

const SYSTEM_PROMPT = [
  '你是创作者兴趣探索分析师。给你用户的核心兴趣方向，生成 2 个相邻但不重叠的探索方向。',
  '硬性要求：',
  '1. 必须与用户既有方向有语义关联（让用户能识别"哦，这个我可以试试"），但角度要差异化',
  '2. 不能直接复述用户输入——要给出新的切入点、视角、受众、或场景',
  '3. 禁止生成与用户方向完全无关的"随机选题"，那样会让推荐失去信任',
  '4. 禁止空洞方向（如"写一篇情感共鸣文"），必须有具体可写的选题',
  '5. content_value ∈ [0,1]：你对这个方向创作价值的估计，参考你的市场经验',
  '',
  '输出一个 JSON 对象，格式为 {"explorations": [ ... ]}，数组中每元素含：',
  '- title: 选题标题（≤40 字）',
  '- description: 一句话说明这个方向的价值和切入角度（≤80 字）',
  '- topic: 适合喂给生成模型的具体主题词（≤60 字，不含修饰语）',
  '- content_value: 0-1 浮点数',
  '',
  '只输出 JSON 对象，不要 markdown 代码块或任何解释。',
].join('\n')

/**
 * 用 LLM 生成 1-2 个探索方向。
 * 失败/降级时返回空数组，不阻塞 build。
 */
export async function getExplorationCandidates(
  seeds: ExplorationSeed[],
  existingClusterLabels: string[] = []
): Promise<Candidate[]> {
  if (!seeds.length) return []
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('[interest] DEEPSEEK_API_KEY 未配置，跳过 S4 exploration')
    return []
  }

  const seedsText = seeds
    .map((s, i) => {
      const kw = s.keywords.length ? ` 关键词：${s.keywords.slice(0, 4).join('、')}` : ''
      return `[${i + 1}] 方向：${s.label}。摘要：${s.summary}${kw}`
    })
    .join('\n')

  const existingHint = existingClusterLabels.length
    ? `\n用户已有方向（避免重复）：${existingClusterLabels.join('、')}`
    : ''

  const userContent = [
    `用户核心兴趣方向：`,
    seedsText,
    existingHint,
    '\n请生成 2 个探索方向，输出 JSON 数组。',
  ].join('\n')

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.6,
        max_tokens: 700,
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
    // 兼容两种形式
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
      })
    }
    return out.slice(0, 2)
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
