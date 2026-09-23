// ============================================================
// KnowledgeUnit —— Creator Knowledge System 的「知识单元」
//
// 与上一层（KnowledgeItem / claims）的分工：
//   scripts.knowledge.claims = 单条素材说了什么（素材级）
//   creator_knowledge        = 跨多条素材归纳出的知识（创作者级）
//
// 这里不存素材原文，只存 source_item_ids 弱引用 —— 知识单元是「归纳后的命题」，
// 不是素材的副本。这也是它敢跨素材聚合的前提：种子藏在创作者自己的资产里。
//
// 表结构见 supabase/migrations/0005_creator_knowledge.sql。
// ============================================================

import {
  CLAIM_KINDS,
  type ClaimKind,
} from '@/lib/creative/knowledgeItem'

// ── 1. 状态机 ─────────────────────────────────────────────

export const KNOWLEDGE_STATUSES = ['候选', '已确认', '已拒绝', '已过期'] as const

export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number]

/**
 * 默认候选：AI 的归纳未经用户确认前，不进 Prompt 注入。
 * 依据 —— 首次配置阶段收益最低的部分就是"AI 自说自话"，先让创建者验收。
 */
export const DEFAULT_KNOWLEDGE_STATUS: KnowledgeStatus = '候选'

export function isKnowledgeStatus(v: unknown): v is KnowledgeStatus {
  return typeof v === 'string' && (KNOWLEDGE_STATUSES as readonly string[]).includes(v)
}

// ── 2. 类型 ───────────────────────────────────────────────

/**
 * 候选单元：聚合器产出物 / INSERT 的形状。
 * 没有 id 与时间戳 —— 那些由数据库生成。
 */
export interface CandidateUnit {
  /** 聚合键：同一「概念」的稳定短名（与 kind 一起构成唯一键） */
  concept: string
  /** 归纳后的完整命题（写成句子，可直接引用） */
  claim: string
  kind: ClaimKind
  /** 适用选题范围，复用 scripts.related_topics 的受控词表 */
  domainScope: string[]
  confidence: number
  /** 来源素材 scripts.id */
  sourceItemIds: string[]
}

/** 库表行（读取侧） */
export interface CreatorKnowledgeUnit extends CandidateUnit {
  id: string
  userId: string
  status: KnowledgeStatus
  sourceCount: number
  createdAt: string
  updatedAt: string
  confirmedAt?: string
}

/**
 * 构成一个知识单元所需的最少独立来源素材数。
 *
 * 为什么是 2：只有一个来源时，这条单元就是那条素材的 claim 本身 —— 没有发生
 * 任何「归纳」，硬塞进 creator_knowledge 只会让素材层和知识层重复。
 * 知识单元的全部附加值就在于「跨素材」。
 */
export const MIN_SOURCES_FOR_UNIT = 2

/**
 * 参与生成注入的置信度阈值，沿用 isKnowledgeUsable 的同口径。
 */
export const KNOWLEDGE_UNIT_CONFIDENCE_THRESHOLD = 0.6

// ── 3. 清洗 ───────────────────────────────────────────────

function s(v: unknown, max: number): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  if (isNaN(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function strList(v: unknown, itemMax: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  for (const item of v) {
    const t = s(item, itemMax)
    if (t) seen.add(t)
    if (seen.size >= maxLen) break
  }
  return Array.from(seen)
}

/**
 * 兜底清洗 LLM 输出的候选单元。
 *
 * 硬规则：
 *   1. concept / claim 任一为空 → null（聚合键缺失就没法去重，命题缺失则不可引用）
 *   2. kind 非法兜底「观点」——抽出来但没分类比没抽出来强（与 normalizeClaims 同口径）
 *   3. 来源不足 MIN_SOURCES_FOR_UNIT → null：单来源不配叫「知识单元」
 *   4. domainScope 去重并截断到 5 个
 * confidence 缺省 0.5，不采信 LLM 的默认乐观值。
 */
export function normalizeCandidateUnit(raw: unknown): CandidateUnit | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const concept = s(o.concept ?? o.name, 60)
  const claim = s(o.claim ?? o.statement, 400)
  if (!concept || !claim) return null

  const kindRaw = o.kind ?? o.type
  const kind: ClaimKind =
    typeof kindRaw === 'string' && (CLAIM_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as ClaimKind)
      : '观点'

  const sourceItemIds = strList(o.sourceItemIds ?? o.source_item_ids, 64, 20)
  if (new Set(sourceItemIds).size < MIN_SOURCES_FOR_UNIT) return null

  return {
    concept,
    claim,
    kind,
    domainScope: strList(o.domainScope ?? o.domain_scope, 40, 5),
    confidence: num(o.confidence, 0, 1, 0.5),
    sourceItemIds: Array.from(new Set(sourceItemIds)),
  }
}

/** 库表行 → 类型化对象（无效返回 null） */
export function normalizeKnowledgeUnit(row: unknown): CreatorKnowledgeUnit | null {
  if (typeof row !== 'object' || row === null) return null
  const o = row as Record<string, unknown>

  const id = s(o.id, 64)
  const userId = s(o.user_id, 64)
  if (!id || !userId) return null

  const candidate = normalizeCandidateUnit(o)
  if (!candidate) return null

  return {
    ...candidate,
    id,
    userId,
    status: isKnowledgeStatus(o.status) ? o.status : DEFAULT_KNOWLEDGE_STATUS,
    sourceCount: Number.isFinite(Number(o.source_count))
      ? Number(o.source_count)
      : candidate.sourceItemIds.length,
    createdAt: s(o.created_at, 40) || new Date().toISOString(),
    updatedAt: s(o.updated_at, 40) || new Date().toISOString(),
    confirmedAt: s(o.confirmed_at, 40) || undefined,
  }
}

// ── 4. 判定 ───────────────────────────────────────────────

/**
 * 是否可注入生成 Prompt。
 *
 * 双重门槛：必须「已确认」且置信度达标。确认状态不会被 AI 自动写回 ——
 * 候选→确认只能由用户操作，这是 Creator Knowledge System 授权链的落点。
 */
export function isUnitInjectable(u: CreatorKnowledgeUnit): boolean {
  return u.status === '已确认' && u.confidence >= KNOWLEDGE_UNIT_CONFIDENCE_THRESHOLD
}

/** 合并来源后是否需要重新请求用户确认 */
export function needsReconfirmation(u: CreatorKnowledgeUnit): boolean {
  return u.status === '已确认' && u.sourceCount < u.sourceItemIds.length
}

/**
 * 合并两条单元的来源（同 concept+kind 命中唯一索引时）。
 * 只并来源，不动 concept/claim —— 后者属于用户已确认的内容。
 */
export function mergeSources(
  existing: CreatorKnowledgeUnit,
  incoming: CandidateUnit
): string[] {
  return Array.from(new Set([...existing.sourceItemIds, ...incoming.sourceItemIds]))
}
