// ============================================================
// WF4：四维标签 TagVector（内容/思想/情绪/创作方式）
//
// 抛弃单一分类标签：每个兴趣簇由 DeepSeek 抽四维标签（各 ≤5），
// builder 拼接后经 bge-m3 得 tag_embedding 存簇行（WF0 §16.10 预置列）。
// 评分侧 InterestMatch = 0.7×语义 + 0.3×标签命中（ranking.ts）。
// 失败降级：LLM 失败 → 空 TagDims → 无 embedding → tagOverlap 兜底 1。
// ============================================================

import type { TagDims } from './types'

export type { TagDims }

const DIM_KEYS: Array<keyof TagDims> = ['content', 'thought', 'emotion', 'craft']
const MAX_TAGS_PER_DIM = 5

export function emptyTagDims(): TagDims {
  return { content: [], thought: [], emotion: [], craft: [] }
}

/** 四维标签拼成一句话（供 bge-m3 计算 tag_embedding） */
export function tagDimsToText(t: TagDims): string {
  return DIM_KEYS.flatMap((k) => t[k] ?? []).join(' ')
}

function sanitizeDim(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, MAX_TAGS_PER_DIM)
}

function sanitize(raw: unknown): TagDims {
  const out = emptyTagDims()
  if (typeof raw !== 'object' || raw === null) return out
  const o = raw as Record<string, unknown>
  for (const k of DIM_KEYS) {
    out[k] = sanitizeDim(o[k])
  }
  return out
}

const SYSTEM_PROMPT = `你是内容标签专家。为每个兴趣簇输出四维标签（每维最多5个，简洁短语，不要解释）：
- content：内容维度（写什么主题/领域）
- thought：思想维度（表达什么观点/思想深度）
- emotion：情绪维度（唤起什么情绪体验）
- craft：创作方式维度（用什么手法/形式创作）
只输出 JSON：{"<tempId>": {"content":[...],"thought":[...],"emotion":[...],"craft":[...]}}`

export interface TagExtractionInput {
  tempId: string
  label: string
  summary: string
  keywords: string[]
  topics: string[]
}

/**
 * 批量抽取四维标签（build 期一次 LLM 调用）。
 * 任何失败 → 每簇 emptyTagDims（永不抛错，build 不阻塞）。
 */
export async function batchExtractTagDims(
  clusters: TagExtractionInput[]
): Promise<Map<string, TagDims>> {
  const results = new Map<string, TagDims>()
  for (const c of clusters) results.set(c.tempId, emptyTagDims())
  if (!clusters.length) return results

  if (!process.env.DEEPSEEK_API_KEY) return results

  try {
    const userContent = clusters
      .map((c) => {
        const topics = c.topics.slice(0, 5).join('；')
        return `[${c.tempId}] 标签:${c.label}｜简介:${c.summary}｜关键词:${c.keywords.join(',')}｜代表主题:${topics}`
      })
      .join('\n')

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
          { role: 'user', content: `为以下 ${clusters.length} 个兴趣簇抽取四维标签：\n${userContent}` },
        ],
        temperature: 0.3,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
      }),
    })
    if (!res.ok) return results

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content
    if (!content) return results

    const parsed = JSON.parse(content) as Record<string, unknown>
    for (const c of clusters) {
      results.set(c.tempId, sanitize(parsed[c.tempId]))
    }
  } catch (e) {
    console.info('[interest] 四维标签抽取失败（降级为空标签）:', e instanceof Error ? e.message : e)
  }
  return results
}

/**
 * 挑选本轮待补算 embedding 的事件：最新优先，上限 50。
 * WF9 实测修复：旧实现 slice(0,50) 正序取头 = 永远补最老的 50 条，
 * 新事件排在队尾永远补不上 → 无向量 → 不聚类 → 不成卡——
 * "用户越用越懂他"的闭环在缺向量事件数 >50 后直接断裂。
 * events 为正序（最老在前，fetchEvents 已 reverse），故取尾部。
 */
export function pickEmbeddingBackfill<T extends { id: string; embedding?: number[] | null | undefined }>(
  events: T[],
  limit = 50
): T[] {
  const missing = events.filter((e) => !Array.isArray(e.embedding) || e.embedding.length !== 1024)
  return missing.slice(-limit)
}

/** 补算输入事件的最小结构：必须有 id；_topic 为补算文本，embedding 就地写回 */
export type BackfillEvent = {
  id: string
  _topic?: string
  embedding?: number[] | null
}

/**
 * embedding 并发补算池（build 耗时治理，WF10）。
 *
 * 背景：旧实现在 builder 步骤3 串行 await 至多 50 个 embedding API（每个 1-2s），
 * 单次要 75-100s；叠加 3 次 LLM 后 build 实测 146s，超过前端 100s 轮询窗口，
 * 用户在第一篇/多作品账号上永远等不到个性化卡。
 *
 * 口径：只补 _topic 非空的事件；worker 池上限 concurrency，任一任务完成立即补位
 * （比分批 Promise.all 快——批内慢任务不拖住整批）；embedFn 返回 null/抛错只跳过
 * 该条并记 error（与旧串行实现容错一致），成功项就地写回 e.embedding 并收集返回，
 * 供调用方一次性 saveEventEmbeddings 回写 DB。
 */
export async function backfillEmbeddings<T extends BackfillEvent>(
  events: T[],
  embedFn: (text: string) => Promise<number[] | null>,
  concurrency = 6
): Promise<Array<{ id: string; embedding: number[] }>> {
  const targets = events.filter((e): e is T & { _topic: string } => typeof e._topic === 'string' && e._topic.length > 0)
  const done: Array<{ id: string; embedding: number[] }> = []
  let cursor = 0

  // 每个 worker 持续取下一条任务直到队列耗尽；worker 数 = 并发上限
  const worker = async () => {
    while (cursor < targets.length) {
      const event = targets[cursor++]
      try {
        const emb = await embedFn(event._topic)
        if (emb && emb.length > 0) {
          event.embedding = emb
          done.push({ id: event.id, embedding: emb })
        }
      } catch (err) {
        // 单条失败不影响其他事件；该条下次 build 重试补算
        console.error('[interest] embedding 补算失败，跳过该事件:', event.id, err instanceof Error ? err.message : String(err))
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()))
  return done
}

/**
 * 标签命中率：候选 embedding 与簇 tag_embedding 的余弦（0-1）。
 * 任一缺失/维度不匹配 → 兜底 1（无标签数据时不打压候选——红线）。
 */
export function tagOverlapFor(
  candidateEmbedding: number[] | null | undefined,
  clusterTagEmbedding: number[] | null | undefined
): number {
  if (!Array.isArray(candidateEmbedding) || candidateEmbedding.length !== 1024) return 1
  if (!Array.isArray(clusterTagEmbedding) || clusterTagEmbedding.length !== 1024) return 1
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < 1024; i++) {
    dot += candidateEmbedding[i] * clusterTagEmbedding[i]
    na += candidateEmbedding[i] * candidateEmbedding[i]
    nb += clusterTagEmbedding[i] * clusterTagEmbedding[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom === 0) return 1
  return Math.max(0, Math.min(1, dot / denom))
}
