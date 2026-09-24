// ============================================================
// Creator Interest Profile —— 证据事实包（纯函数，单一口径）
//
// 为什么单独成模块：
//   evidence.facts 的构造此前在 builder 与 refill 两处各写一遍，且只覆盖
//   create/finalize/save 三类计数。结果是推荐理由只能说"你生成过 N 篇"——
//   而用户明明还改过稿、搜过主题、分析过选题、采纳过推荐，这些同样是"为什么
//   推荐它"的硬事实。两处各写一遍则必然随业务演进漂移（P0 已吃过这个亏）。
//
// 扩到 7 类的取舍：
//   只收"用户对某个方向投入过注意力"的**正向可复述**事实。
//   刻意不收 recommend_dismiss（负向）：模板理由若写出"你点过 N 次✕"，
//   既冒犯又无信息量，而负向已经通过 hardFilter 过滤候选表达了。
//
// 红线：facts 里的每个数字都必须来自 creator_events 的实际行数，绝不估算、
//   绝不凭空补全（AI 理由的事实校验依赖这一点）。
// ============================================================

export const EVIDENCE_FACT_TYPES = [
  'create',
  'finalize',
  'save',
  'edit',
  'adopt',
  'analyze',
  'search',
] as const

export type EvidenceFactType = (typeof EVIDENCE_FACT_TYPES)[number]

/** 证据事实类型 → 推荐理由里的中文量词短语（%d 处填计数） */
export const FACT_TYPE_LABEL: Record<EvidenceFactType, string> = {
  create: '生成 %d 篇',
  finalize: '定稿 %d 篇',
  save: '收藏 %d 条相关案例',
  edit: '改过 %d 次稿',
  adopt: '采纳过 %d 条同方向推荐',
  analyze: '分析过 %d 个同方向选题',
  search: '主动搜过 %d 次相关主题',
}

/**
 * creator_events.event_type → 证据事实类型。
 * 不在表内的事件类型（点赞/广场互动等）不进事实包：
 * 它们不是"对这个选题方向的投入"，写进理由会稀释可信度。
 */
export const EVENT_TYPE_TO_FACT: Record<string, EvidenceFactType> = {
  work_generate: 'create',
  work_finalize: 'finalize',
  material_save: 'save',
  work_edit: 'edit',
  recommend_adopt: 'adopt',
  inspiration_analyze: 'analyze',
  topic_search: 'search',
}

export type FactCounts = Partial<Record<EvidenceFactType, number>>

export interface EvidenceFact {
  type: EvidenceFactType
  count: number
  cluster_label: string
}

/** 空计数表（refill 无簇/无事件时的兜底） */
export function emptyFactCounts(): FactCounts {
  return {}
}

/**
 * 按事件类型累加计数（未知事件类型忽略）。
 * 这是 builder 与 refill 共用的唯一累加口径。
 */
export function accumulateFact(counts: FactCounts, eventType: string | null | undefined): void {
  if (!eventType) return
  const fact = EVENT_TYPE_TO_FACT[eventType]
  if (!fact) return
  counts[fact] = (counts[fact] ?? 0) + 1
}

/**
 * 计数表 → 事实数组。
 *
 * 只输出计数 > 0 的项（AI 理由侧的准入门槛是 facts 非空，零计数项会让
 * 无事实的候选误过准入，进而诱导 LLM 编造）；顺序固定为 EVIDENCE_FACT_TYPES，
 * 保证同一簇多次 build 产出的 facts 可 diff。
 */
export function buildEvidenceFacts(counts: FactCounts, clusterLabel: string): EvidenceFact[] {
  const out: EvidenceFact[] = []
  for (const type of EVIDENCE_FACT_TYPES) {
    const n = counts[type] ?? 0
    if (n > 0) out.push({ type, count: n, cluster_label: clusterLabel })
  }
  return out
}

/** 事实数组是否"有内容"（AI 理由的准入门槛） */
export function hasFacts(facts: unknown): boolean {
  return Array.isArray(facts) && facts.length > 0
}

/** 单条事实 → 中文短语（供 AI 理由输入与模板理由复用） */
export function factToText(fact: { type?: unknown; count?: unknown }): string {
  const type = typeof fact.type === 'string' ? fact.type : ''
  const tpl = (FACT_TYPE_LABEL as Record<string, string | undefined>)[type] ?? '%d 次相关行为'
  return tpl.replace('%d', String(Number(fact.count) ?? 0))
}
