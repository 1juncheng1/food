// ============================================================
// Creator Knowledge System · Phase 3 —— 知识单元注入生成链路
//
// 前两阶段解决了「归纳」与「授权」，本文件解决最后一米：让被用户确认过的
// 知识真正进入生成，而不是躺在表里。
//
// 为什么能用确定性打分，不需要再调一次 LLM：
//   迁移 0005 原本的设想是「先用 domain_scope 的 && 重叠粗筛，再交给 LLM
//   仲裁」。但落地时 domainScope 的值域是 LLM 从用户素材里提炼的自由文本
//   （见 knowledgeAggregator 的 prompt：「优先复用分组已给出的适用场景用词」），
//   并非迁移注释设想的受控词表。对着自由文本做数组等值重叠，几乎必然落空。
//   因此这里沿用 lib/material/retrieval.ts 已有的「主题词字面交集」口径：
//   topic 文本内包含 unit 的 concept / domainScope 词条即计分。
//
//   这条选择同时守住了迁移里另一条更硬的原则——「不为知识单元再建一套向量检索」。
//   知识单元数量级很小（上限 MAX_ROWS），打分是纯函数、零 token、可测试，
//   也就不存在"人类查 TK、AI 另有一套 ESA"的口径分裂。
//
// 授权边界（不要越过）：
//   只有 status='已确认' 且 confidence 达标（isUnitInjectable）的单元才可能被注入。
//   AI 侧永远只写候选，候选→确认必须由用户在 /knowledge 手动完成。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isUnitInjectable,
  normalizeKnowledgeUnit,
  type CreatorKnowledgeUnit,
} from '@/lib/creative/knowledgeUnit'

// ── 常量 ─────────────────────────────────────────────────

/** 单次生成最多注入的单元数：够用即可，多了会稀释创作蓝图与风格的权重 */
export const MAX_INJECT_UNITS = 5

/** 读取上限：真实规模远小于此，主要防止异常数据拖慢生成 */
const MAX_ROWS = 100

/** concept 命中权重：聚合键，指名道姓，是最强的相关信号 */
const CONCEPT_HIT = 3

/** domainScope 命中权重：适用场景，次强 */
const DOMAIN_HIT = 2

/** 参与匹配的最小词长：低于此长度的词（如单字）在中文里几乎必然误命中 */
const MIN_TERM_LEN = 2

// ── 读取 ─────────────────────────────────────────────────

/**
 * 读取可注入的知识单元（已确认 + 置信度达标）。
 *
 * 失败一律降级为空数组，绝不阻断生成：知识是增强项，不是主链路的必经节点。
 * 表未迁移（42P01）时连日志都不打——那是尚未启用的正常状态，不是故障。
 */
export async function fetchInjectableUnits(
  client: SupabaseClient,
  userId: string
): Promise<CreatorKnowledgeUnit[]> {
  let rows: unknown[] = []

  try {
    const res = await client
      .from('creator_knowledge')
      .select('*')
      .eq('user_id', userId)
      .eq('status', '已确认')
      .order('updated_at', { ascending: false })
      .limit(MAX_ROWS)

    if (res.error) {
      const code = (res.error as { code?: string }).code
      if (code !== '42P01') {
        console.error('knowledge-inject: 读取失败（降级为空）:', res.error.message)
      }
      return []
    }
    rows = Array.isArray(res.data) ? res.data : []
  } catch (e) {
    console.error('knowledge-inject: 读取异常（降级为空）:', e)
    return []
  }

  return rows
    .map(normalizeKnowledgeUnit)
    .filter((u): u is CreatorKnowledgeUnit => u !== null && isUnitInjectable(u))
}

// ── 相关性打分 ───────────────────────────────────────────

/**
 * topic 与单元的确定性相关性得分，0 表示无关。
 *
 * 同一词条（concept 恰好等于某个 domainScope）只计一次分，
 * 否则同一件事会因为出现在两个字段里而被重复加权，挤掉真正相关的单元。
 */
export function relevanceScore(u: CreatorKnowledgeUnit, topic: string): number {
  const t = (topic ?? '').trim()
  if (!t) return 0

  const terms: Array<[string, number]> = [
    [u.concept, CONCEPT_HIT],
    ...u.domainScope.map((d): [string, number] => [d, DOMAIN_HIT]),
  ]

  let score = 0
  const counted = new Set<string>()

  for (const [raw, weight] of terms) {
    const term = (raw ?? '').trim()
    if (term.length < MIN_TERM_LEN) continue
    if (counted.has(term)) continue
    counted.add(term)
    if (t.includes(term)) score += weight
  }

  return score
}

/**
 * 挑出本次要注入的单元：只留有相关性的（score > 0），按
 * 相关度 → 置信度 → id 排序。带 id 兜底是为了排序完全确定，
 * 同样的输入永远得到同一批单元，便于复现与回归。
 */
export function selectUnitsForPrompt(
  units: CreatorKnowledgeUnit[],
  topic: string,
  max: number = MAX_INJECT_UNITS
): CreatorKnowledgeUnit[] {
  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 0
  if (limit === 0) return []

  return units
    .map((u) => ({ unit: u, score: relevanceScore(u, topic) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.unit.confidence !== a.unit.confidence) {
        return b.unit.confidence - a.unit.confidence
      }
      return a.unit.id < b.unit.id ? -1 : a.unit.id > b.unit.id ? 1 : 0
    })
    .slice(0, limit)
    .map((x) => x.unit)
}

// ── Prompt 拼装 ──────────────────────────────────────────

/**
 * 把选中的单元拼成 prompt 块。
 *
 * 末尾两条规则比知识本身更重要：这块是「创作者自己的话」，一旦 AI 借它的
 * 名义向外扩写，就变成了把编造的观点算到用户头上——这比不注入更糟。
 */
export function formatKnowledgeForPrompt(units: CreatorKnowledgeUnit[]): string {
  if (units.length === 0) return ''

  const lines = units.map((u) => `- [${u.kind}] ${u.claim}`).join('\n')

  return `【创作者自己确认过的知识】（以下命题来自该创作者多条素材的交叉印证，且经本人逐条确认）
${lines}

使用规则：
1、这些是可信论据，可作为论述依据或直接引用来源，但严禁歪曲、放大、改写原意；
2、上方未列出的主张一律不得代为编造——创作者没有表达过的观点，不要替他说。`
}

// ── 一次性组合（供 route 调用） ──────────────────────────

export interface KnowledgeInjection {
  /** 拼好的 prompt 块，无命中时为空串 */
  block: string
  /** 实际被注入的单元，用于回传前端展示「本次用了哪些知识」 */
  units: CreatorKnowledgeUnit[]
}

/**
 * 读取 → 打分 → 拼块 的一次性入口。任何一步为空都产出空 block，
 * 调用方可以直接把它拼进 prompt 而无需判空。
 */
export async function buildKnowledgeInjection(
  client: SupabaseClient,
  userId: string,
  topic: string
): Promise<KnowledgeInjection> {
  const units = await fetchInjectableUnits(client, userId)
  const selected = selectUnitsForPrompt(units, topic)
  return { block: formatKnowledgeForPrompt(selected), units: selected }
}

// ── 回传摘要 ─────────────────────────────────────────────

/**
 * 回传给前端的最小信息：够展示「本次用了哪几条知识」，不含内部 ids。
 *
 * kind / confidence 允许 null：新鲜对象是完整的，但从 generation_history.used_knowledge
 * jsonb 读回来的历史行可能缺字段（该列上线前的老版本、或中间迭代改过写入形状），
 * 与其用一个假的 0 冒充置信度，不如如实留 null。
 */
export interface InjectedUnitSummary {
  concept: string
  claim: string
  kind: string | null
  confidence: number | null
}

/**
 * 生成可为 API 响应使用的摘要。
 *
 * 刻意不回传 sourceItemIds：那是素材溯源信息，属于内部债务追踪，
 * 没有理由出现在给浏览器的响应里。
 */
export function summarizeInjectedUnits(
  units: CreatorKnowledgeUnit[]
): InjectedUnitSummary[] {
  return units.map((u) => ({
    concept: u.concept,
    claim: u.claim,
    kind: u.kind,
    confidence: u.confidence,
  }))
}

/**
 * 从 generation_history.used_knowledge（jsonb）还原注入快照。
 *
 * 为什么要逐字段校验而不是 `as` 断言：这一列的读者是「几个月后回看旧作品的用户」，
 * 而 jsonb 里躺着什么形状取决于写入那天的代码版本——任何一次字段改名都会让历史行
 * 变成半成品对象。按本项目惯例（normalizeBlueprint / parseDiagnosis /
 * normalizeEditPatches），从库里出来的东西一律当不可信输入处理。
 *
 * 缺字段或形状不对的条目直接丢弃：宁可少展示一条，也不要把 undefined 渲染到用户眼前。
 */
export function normalizeInjectedUnits(raw: unknown): InjectedUnitSummary[] {
  if (!Array.isArray(raw)) return []
  const out: InjectedUnitSummary[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const concept = typeof o.concept === 'string' ? o.concept.trim() : ''
    const claim = typeof o.claim === 'string' ? o.claim.trim() : ''
    // 概念与命题是这条记录的本体，任一缺失都不足以告诉用户"参考了什么"
    if (!concept || !claim) continue
    out.push({
      concept,
      claim,
      kind: typeof o.kind === 'string' && o.kind.trim() ? o.kind.trim() : null,
      confidence:
        typeof o.confidence === 'number' && Number.isFinite(o.confidence)
          ? o.confidence
          : null,
    })
  }
  return out
}
