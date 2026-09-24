// ============================================================
// retrieval —— Material Library 2.0 Phase 3 素材召回服务
//
// 核心机制（详见 .claude/artifacts/plans/material-library-p3.md）：
//   1. 纯主题向量：match_scripts 的 query_embedding 只允许是 currentTopic 自身的
//      bge-m3 向量，全链路不存在任何 mixVectors/加权混入（修复风格向量污染）。
//      currentIntent/currentContext 永不参与向量构造。
//   2. top20 召回（match_count=20）→ 原始相似度硬阈值过滤（≥0.55）。
//   3. ±0.02 相似度带内标签软排序：类型/usage/主题词信号最多颠倒同带候选顺序，
//      结构上永远无法决定召回门槛。
//   4. selectedMaterialIds：命中的本人素材无视阈值强制返回、置顶、score=1、
//      与自动召回去重、超 10 截断；RLS 丢弃的 id 进 meta.missingSelectedIds。
//   5. RPC 只回 id/content/similarity，缺字段用一次主键 id IN (...) 批量补齐，
//      不改 match_scripts RPC（避免再次 DROP+CREATE 的生产中断）。
//   6. 全降级：embedding 失败返回 selected/空 + meta.degraded='embedding'，不抛错；
//      LLM 理由失败逐条回退模板。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateEmbedding } from '@/lib/storage'
import {
  MATERIAL_TYPES,
  type MaterialRetrievalInput,
  type MaterialRetrievalResult,
  type MaterialRetrievalMeta,
  type MaterialType,
  type RelevanceReasonMode,
} from '@/lib/creative/material'
import {
  KNOWLEDGE_DIMENSIONS,
  type KnowledgeItem,
  type UsageTag,
} from '@/lib/creative/knowledgeItem'
import {
  buildTemplateReason,
  generateLlmReasons,
  SELECTED_REASON,
} from './reasons'

// ── 单点常量（AC-13 阈值标定只改这一处） ──────────────────

/** 自动召回硬阈值：原始相似度低于此值一律不进入结果。拿不准只上调不下调。 */
export const MATERIAL_SIMILARITY_THRESHOLD = 0.55
/** 单次 RPC over-fetch 条数 */
export const CANDIDATE_FETCH_COUNT = 20
/** 自动召回返回条数上限 */
export const DEFAULT_AUTO_LIMIT = 5
/** 用户主动选择素材的最大条数（超出截断） */
export const MAX_SELECTED = 10
/** 注入 prompt 的素材总条数上限（selected 优先占额；防止 prompt 被撑爆） */
export const MAX_INJECT_TOTAL = 8

// ── 软排序信号权重（结构上限：仅在 ±0.02 同带内生效，禁止调大到可跨带） ──

const TYPE_HIT_BONUS = 0.03
const USAGE_HIT_BONUS = 0.03
const TOPIC_HIT_BONUS = 0.02
/** 带宽 0.02：bandIndex = floor(sim * 50) */
const BAND_DIVISOR = 50

// ── 意图 → 素材类型/用途映射（白名单制；不在表内的意图 0 加分，R11） ──

const INTENT_TO_TYPES: Record<string, MaterialType[]> = {
  观点展开: ['观点'],
  事实支撑: ['事实', '数据'],
  数据支撑: ['数据'],
  案例引用: ['案例'],
  金句引用: ['金句'],
}

function resolveIntentTypes(intent: string | undefined): MaterialType[] {
  if (!intent) return []
  // 意图本身就是 9 种素材类型字面量（如 retrieve API 直接传「数据」）
  if ((MATERIAL_TYPES as readonly string[]).includes(intent)) {
    return [intent as MaterialType]
  }
  return INTENT_TO_TYPES[intent] ?? []
}

function resolveIntentUsage(intent: string | undefined): UsageTag | null {
  if (!intent) return null
  const values = KNOWLEDGE_DIMENSIONS.usage.values as readonly string[]
  return values.includes(intent) ? (intent as UsageTag) : null
}

// ── 数据形状 ─────────────────────────────────────────────

/** scripts 表主键批量水合后的行（RPC 只回 id/content/similarity） */
interface HydratedRow {
  id: string
  content: string | null
  type: string | null
  material_type: string | null
  ai_summary: string | null
  related_topics: string[] | null
  knowledge: KnowledgeItem | null
}

/** 通过阈值过滤、水合后的自动召回候选（结构满足 CandidateLike） */
interface AutoCandidate extends CandidateLike {
  row: HydratedRow
}

/** 可单测的候选最小形态（纯函数用） */
export interface CandidateLike {
  id: string
  similarity: number
  materialType: MaterialType | null
  relatedTopics: string[] | null
  usageTags: UsageTag[]
}

export interface SoftSignalContext {
  intent?: string
  topic: string
}

// ── 纯函数（全部可单测） ─────────────────────────────────

/** selectedMaterialIds 清洗：只接受字符串数组（去重、保序、截断 MAX_SELECTED） */
export function normalizeSelectedIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string') continue
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= MAX_SELECTED) break
  }
  return out
}

/** material_type 落库无 DB CHECK，应用层校验为 9 种枚举之一，否则视为 null */
function normalizeMaterialType(v: unknown): MaterialType | null {
  return typeof v === 'string' && (MATERIAL_TYPES as readonly string[]).includes(v)
    ? (v as MaterialType)
    : null
}

/** 主题词与 related_topics 的字面交集（长度 ≥2 的主题词出现在当前主题文本中） */
function topicIntersectionHit(relatedTopics: string[] | null, topic: string): boolean {
  if (!topic) return false
  return (relatedTopics ?? []).some(
    (t) => typeof t === 'string' && t.trim().length >= 2 && topic.includes(t.trim())
  )
}

/**
 * 软信号加分：类型命中 +0.03、usage 命中 +0.03、主题词交集 +0.02。
 * 仅参与同带内比较，任何组合（上限 0.08）都无法跨越 0.02 带边界。
 */
export function softSignalBoost(c: CandidateLike, ctx: SoftSignalContext): number {
  let boost = 0
  const wantedTypes = resolveIntentTypes(ctx.intent)
  if (c.materialType && wantedTypes.includes(c.materialType)) boost += TYPE_HIT_BONUS
  const wantedUsage = resolveIntentUsage(ctx.intent)
  if (wantedUsage && c.usageTags.includes(wantedUsage)) boost += USAGE_HIT_BONUS
  if (topicIntersectionHit(c.relatedTopics, ctx.topic)) boost += TOPIC_HIT_BONUS
  return boost
}

/**
 * 带状比较器（防标签越权的核心机制）：
 *   - 先比相似度带 bandIndex=floor(sim*50)（0.02 带宽）：不同带一律原始相似度高者胜，
 *     软信号无权干预——标签永远无法让 0.4 入选/0.8 落选；
 *   - 同带内再比 sim + 软信号加分；
 *   - 再平局回退原始相似度、id，保证排序确定性。
 * 返回负数表示 a 排在前。
 */
export function compareCandidates(
  a: CandidateLike,
  b: CandidateLike,
  ctx: SoftSignalContext
): number {
  const bandA = Math.floor(a.similarity * BAND_DIVISOR)
  const bandB = Math.floor(b.similarity * BAND_DIVISOR)
  if (bandA !== bandB) {
    return b.similarity - a.similarity
  }
  const adjusted =
    b.similarity + softSignalBoost(b, ctx) - (a.similarity + softSignalBoost(a, ctx))
  if (adjusted !== 0) return adjusted
  if (a.similarity !== b.similarity) return b.similarity - a.similarity
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ── DB 辅助 ─────────────────────────────────────────────

const HYDRATE_COLUMNS =
  'id,content,type,material_type,ai_summary,related_topics,knowledge'

/** 一次主键 id IN (...) 批量补齐 RPC 不返回的字段；RLS 自动限本人素材 */
async function fetchRowsByIds(
  client: SupabaseClient,
  ids: string[]
): Promise<HydratedRow[]> {
  if (ids.length === 0) return []
  const { data, error } = await client
    .from('scripts')
    .select(HYDRATE_COLUMNS)
    .in('id', ids)
  if (error) {
    console.error('素材水合查询失败（不影响降级）:', error)
    return []
  }
  return Array.isArray(data) ? (data as HydratedRow[]) : []
}

function toAutoCandidate(row: HydratedRow, similarity: number): AutoCandidate {
  return {
    id: row.id,
    row,
    similarity,
    materialType: normalizeMaterialType(row.material_type),
    relatedTopics: Array.isArray(row.related_topics) ? row.related_topics : null,
    usageTags: row.knowledge?.usage_tags ?? [],
  }
}

function toResult(
  row: HydratedRow,
  similarity: number,
  reason: string
): MaterialRetrievalResult {
  return {
    materialId: row.id,
    content: typeof row.content === 'string' ? row.content : '',
    materialType: normalizeMaterialType(row.material_type),
    relevanceScore: similarity,
    relevanceReason: reason,
  }
}

// ── 主入口 ───────────────────────────────────────────────

export interface RetrieveOptions {
  /** 理由模式，默认 'template'（prompt-optimizer 内部永远 template） */
  reasonMode?: RelevanceReasonMode
  /** 预计算主题向量（prompt-optimizer 复用，零新增 embedding） */
  topicEmbedding?: number[]
  /** 自动召回条数上限，默认 5 */
  autoLimit?: number
  /**
   * Phase 4 计费上下文：**只有 reasonMode='llm' 时才会真的产生调用**，
   * 因此也只有那条分支会扣费。不传则行为与改造前完全一致。
   */
  billing?: { supabase: SupabaseClient; userId: string; refId?: string }
}

/**
 * 素材召回。任何内部失败都降级为「少返回/不返回素材」，绝不抛错。
 */
export async function retrieveMaterials(
  client: SupabaseClient,
  input: MaterialRetrievalInput,
  opts: RetrieveOptions = {}
): Promise<{ materials: MaterialRetrievalResult[]; meta: MaterialRetrievalMeta }> {
  const reasonMode: RelevanceReasonMode = opts.reasonMode ?? 'template'
  const autoLimit = opts.autoLimit ?? DEFAULT_AUTO_LIMIT
  const meta: MaterialRetrievalMeta = {
    degraded: null,
    recalledCandidateCount: 0,
    missingSelectedIds: [],
    reasonMode,
    threshold: MATERIAL_SIMILARITY_THRESHOLD,
  }

  // 1) selected 强制集：RLS 限本人，查不到的 id（不存在/跨用户）静默进 missing
  const requestedSelected = normalizeSelectedIds(input.selectedMaterialIds)
  const selectedRows = await fetchRowsByIds(client, requestedSelected)
  const selectedIdSet = new Set(selectedRows.map((r) => r.id))
  meta.missingSelectedIds = requestedSelected.filter((id) => !selectedIdSet.has(id))

  // 2) 主题向量：只允许 currentTopic 进嵌入（currentIntent/currentContext 永不参与，
  //    防二次污染，教训见 prompt-optimizer 历史作品检索段）
  const precomputed =
    Array.isArray(opts.topicEmbedding) && opts.topicEmbedding.length > 0
      ? opts.topicEmbedding
      : null
  // storage.generateEmbedding 自身已吞错返回 null；这里再兜一层异常（AC-6：不抛错）
  let topicEmbedding: number[] | null = precomputed
  if (!topicEmbedding) {
    try {
      topicEmbedding = await generateEmbedding(input.currentTopic)
    } catch (e) {
      console.warn('主题嵌入调用异常（降级为仅 selected）:', e)
      topicEmbedding = null
    }
  }
  if (!topicEmbedding) {
    // embedding 失败：selected（可能为空）照常返回，自动召回整体放弃
    return {
      materials: selectedRows.map((r) => toResult(r, 1, SELECTED_REASON)),
      meta: { ...meta, degraded: 'embedding' },
    }
  }

  // 3) 单次纯主题向量召回：不传 p_usage_filter / p_material_type（标签不能做硬门槛）
  const { data: rpcData, error: rpcError } = await client.rpc('match_scripts', {
    query_embedding: topicEmbedding,
    match_count: CANDIDATE_FETCH_COUNT,
    p_user_id: input.userId,
  })
  if (rpcError) {
    console.error('素材向量召回 RPC 失败（降级为仅 selected）:', rpcError)
    return {
      materials: selectedRows.map((r) => toResult(r, 1, SELECTED_REASON)),
      meta,
    }
  }

  // 4) 硬阈值过滤 + 与 selected 去重（水合之前先去重，省一次字段补齐）
  const rpcRows = (Array.isArray(rpcData) ? rpcData : []) as Array<{
    id?: unknown
    content?: unknown
    similarity?: unknown
  }>
  const passed = rpcRows.filter(
    (r) =>
      typeof r.id === 'string' &&
      typeof r.similarity === 'number' &&
      r.similarity >= MATERIAL_SIMILARITY_THRESHOLD &&
      !selectedIdSet.has(r.id)
  ) as Array<{ id: string; similarity: number }>
  meta.recalledCandidateCount = passed.length

  // 5) 一次主键 IN 批量水合，建 id → row 映射（保持 RPC 的相似度顺序）
  const hydratedRows = await fetchRowsByIds(
    client,
    passed.map((r) => r.id)
  )
  const rowById = new Map(hydratedRows.map((r) => [r.id, r]))
  const autoCandidates: AutoCandidate[] = []
  for (const r of passed) {
    const row = rowById.get(r.id)
    if (row) autoCandidates.push(toAutoCandidate(row, r.similarity))
  }

  // 6) ±0.02 带内软排序 → 取前 autoLimit（relevanceScore 仍记原始相似度）
  const ctx: SoftSignalContext = {
    intent: input.currentIntent,
    topic: input.currentTopic,
  }
  autoCandidates.sort((a, b) => compareCandidates(a, b, ctx))
  const picked = autoCandidates.slice(0, autoLimit)

  // 7) 理由：selected 固定文案；自动项按 reasonMode 生成，llm 失败整体回退模板
  let llmReasonMap: Record<string, string> | null = null
  if (reasonMode === 'llm' && picked.length > 0) {
    llmReasonMap = await generateLlmReasons(
      input.currentTopic,
      picked.map((c) => ({
        id: c.id,
        content: typeof c.row.content === 'string' ? c.row.content : '',
        materialType: c.materialType,
      })),
      opts.billing
    )
    if (!llmReasonMap) meta.degraded = 'llm_reason'
  }

  const autoResults: MaterialRetrievalResult[] = picked.map((c) => {
    const reason =
      llmReasonMap?.[c.id] ??
      buildTemplateReason({
        similarity: c.similarity,
        materialType: c.materialType,
        relatedTopics: c.relatedTopics,
      })
    return toResult(c.row, c.similarity, reason)
  })

  // 8) selected 置顶 + 自动召回在后
  const selectedResults = selectedRows.map((r) => toResult(r, 1, SELECTED_REASON))
  return {
    materials: [...selectedResults, ...autoResults],
    meta,
  }
}
