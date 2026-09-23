// ============================================================
// knowledgeAggregator —— 跨素材 claims → 知识单元候选
//
// 两阶段设计，边界刻意划死：
//   A. 分桶（纯函数，无 LLM）：按 applicableScopes + kind 把 claims 聚类
//   B. 归纳（LLM）：只让模型做语义工作 —— 命名概念、写成可引用命题
//
// 关键取舍：sourceItemIds 由阶段 A 确定性给出，LLM 全程不参与。
// 让模型回传 UUID 等于把「引用真实性」交给它编 —— 这是知识系统最不能错的字段。
// LLM 出错最多得到一个糟糕的命题（用户可见、可拒绝）；
// 来源被编造则会让一条无据可查的断言看起来有出处。
//
// 另一个约束：只处理跨素材来源数已达 MIN_SOURCES_FOR_UNIT 的分组。
// 单素材的 claim 不参与 —— 那是素材层的事，进知识层只会制造重复。
// ============================================================

import { callDeepSeekChat } from '@/lib/llm'
import type { ClaimKind, KnowledgeClaim } from '@/lib/creative/knowledgeItem'
import {
  MIN_SOURCES_FOR_UNIT,
  normalizeCandidateUnit,
  type CandidateUnit,
} from '@/lib/creative/knowledgeUnit'

const LLM_TIMEOUT_MS = 60_000

// ── 1. 输入类型 ───────────────────────────────────────────

/** 一条带来源素材的主张 */
export interface ClaimRef {
  itemId: string
  claim: KnowledgeClaim
}

/** 阶段 A 的产物：一个可被 LLM 归纳的候选分组 */
export interface UnitGroup {
  scope: string
  kind: ClaimKind
  /** 去重后的来源素材 id */
  itemIds: string[]
  claims: Array<{
    text: string
    confidence: number
    source?: string
  }>
}

export interface AggregateOptions {
  /** 一个分组至少要有几个独立来源，默认 MIN_SOURCES_FOR_UNIT */
  minSources?: number
  /** 单次最多归纳多少组（控制 token），默认 10 */
  maxGroups?: number
  /** 单组最多带多少条 claim，默认 12 */
  maxClaimsPerGroup?: number
}

export interface AggregateResult {
  units: CandidateUnit[]
  /** LLM 未产出可用结果（并非没有候选分组） */
  degraded: boolean
}

// ── 2. 阶段 A：确定性分桶 ────────────────────────────────

/**
 * 把跨素材的 claims 按「适用场景 + 主张种类」分组。
 *
 * 为什么要把 kind 一起作为分组键：同一话题下的「数据」与「观点」是两种东西，
 * 硬合成一条 unit 会让 Phase 3 失去区分能力 —— 数据和观点在引用时限完全不同。
 *
 * 分组规模排序后截断：token 预算有限，优先处理跨素材最广的组。
 *
 * @returns 满足条件且已按跨素材广度降序排列的分组
 */
export function groupClaims(refs: ClaimRef[], opts?: AggregateOptions): UnitGroup[] {
  const minSources = opts?.minSources ?? MIN_SOURCES_FOR_UNIT
  const maxClaimsPerGroup = opts?.maxClaimsPerGroup ?? 12

  // scope → kind → refs（二级索引：同一场景下不同种类的主张要分开归纳）
  const byScope = new Map<string, Map<ClaimKind, ClaimRef[]>>()

  for (const ref of refs) {
    const scopes = ref.claim.applicableScopes ?? []
    // 没有适用场景的主张无法被确定性归类 —— 跳过而不是塞进某个通配桶，
    // 否则不相关的主张会因为「都没分类」而被聚在一起
    if (scopes.length === 0) continue

    for (const rawScope of scopes) {
      const scope = typeof rawScope === 'string' ? rawScope.trim() : ''
      if (!scope) continue

      let byKind = byScope.get(scope)
      if (!byKind) {
        byKind = new Map<ClaimKind, ClaimRef[]>()
        byScope.set(scope, byKind)
      }
      const list = byKind.get(ref.claim.kind) ?? []
      list.push(ref)
      byKind.set(ref.claim.kind, list)
    }
  }

  const groups: UnitGroup[] = []

  for (const [scope, byKind] of byScope) {
    for (const [kind, list] of byKind) {
      const itemIds = Array.from(new Set(list.map((r) => r.itemId)))
      // 单来源不成之为「跨素材归纳」
      if (itemIds.length < minSources) continue

      groups.push({
        scope,
        kind,
        itemIds,
        claims: list.slice(0, maxClaimsPerGroup).map((r) => ({
          text: r.claim.text,
          confidence: r.claim.confidence,
          source: r.claim.source,
        })),
      })
    }
  }

  // 跨素材广度优先：来源越多，说明这个概念在创作者素材库里越稳固
  groups.sort((a, b) => b.itemIds.length - a.itemIds.length)

  const maxGroups = opts?.maxGroups ?? 10
  return groups.slice(0, maxGroups)
}

// ── 3. 阶段 B：LLM 归纳 ──────────────────────────────────

function buildSystemPrompt(): string {
  return `你是创作者的知识库编辑。你的任务是把同一位创作者**多条素材**中关于同一件事的说法，归纳成一条可引用的知识单元。

输入是若干「分组」。每个分组来自同一适用场景、同一种主张，且**来自多条不同素材**。

输出严格 JSON：
{
  "units": [
    {
      "group": 0,
      "concept": "概念短名，2-12 字，作为长期聚合键（同一概念必须始终用同一个名字）",
      "claim": "归纳后的完整命题，写成可直接引用的完整句子",
      "confidence": 0.75,
      "domainScope": ["适用场景", "最多 5 个"]
    }
  ]
}

## 铁律

1. **禁止引入任何素材里没有的信息**：不得补充外部常识、不得加数字、不得加作者/作品名。素材没说的，一律不写。
2. **只归纳分组内部已经共有的东西**：如果几条说法其实指向不同概念，宁可少出单元，也不要把无关内容缝在一起。
3. claim 必须是**完整句子**，能看到主谓宾，能独立被引用于生成内容。禁止写成词组或标签。
   - 反例："AI 与教育"（标签）
   - 正例："AI 不会取代老师，而是把老师从重复劳动中解放出来"（命题）
4. 保留创作者的**原立场**。分组内的观点若带倾向性，禁止中性化、禁止弱化。
   把立场磨平的知识单元会让生成内容失去这个人的观点。
5. 每条分组**最多提炼 2 个单元**。提炼不出来就跳过该分组（不要为了凑数输出）。
6. confidence 只反映归纳把握：多条素材互相印证且无歧义 → 0.8 以上；勉强相关 → 0.5 左右；只是勉强拼在一起 → 不要输出。

## domainScope 取值

优先复用分组已给出的适用场景用词。只有在明显缺漏时才补充，且必须是创作者素材里出现过的概念，不得新造领域词。`
}

function buildUserPrompt(groups: UnitGroup[]): string {
  const payload = groups.map((g, i) => ({
    group: i,
    适用场景: g.scope,
    主张种类: g.kind,
    来源素材数: g.itemIds.length,
    claims: g.claims.map((c) => ({
      text: c.text,
      confidence: c.confidence,
      ...(c.source ? { source: c.source } : {}),
    })),
  }))

  return `以下是来自同一位创作者素材库的候选分组（${groups.length} 组）。每组内部的主张来自 ${groups
    .map((g) => g.itemIds.length)
    .join('/')} 条不同素材。

${JSON.stringify(payload, null, 2)}

请归纳成知识单元，只输出 JSON。若某组实在无法归纳，跳过即可（允许 units 为空数组）。`
}

function extractJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

/**
 * 调用 LLM 把分组归纳成知识单元候选。
 *
 * 来源素材 id 不进 prompt、也不从返回值取 —— 由 groupClaims 确定性给定。
 * 返回值经清洗校验后才被采纳，非法即丢弃（宁可少一条，不要一条错的）。
 */
export async function aggregateUnits(
  groups: UnitGroup[],
  opts?: { timeoutMs?: number }
): Promise<AggregateResult> {
  // 没有合格分组时不要浪费一次 LLM 调用
  if (groups.length === 0) return { units: [], degraded: false }

  const res = await callDeepSeekChat({
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(groups) },
    ],
    temperature: 0.3,
    max_tokens: 2000,
    jsonMode: true,
    timeoutMs: opts?.timeoutMs ?? LLM_TIMEOUT_MS,
  })

  if (!res.ok) {
    console.error('knowledgeAggregator: LLM 调用失败:', res.error)
    return { units: [], degraded: true }
  }

  const parsed = extractJson(res.content)
  if (typeof parsed !== 'object' || parsed === null) {
    return { units: [], degraded: true }
  }

  const rawUnits = (parsed as Record<string, unknown>).units
  if (!Array.isArray(rawUnits)) return { units: [], degraded: true }

  const out: CandidateUnit[] = []
  // 同名概念去重：LLM 在不同分组里可能给出同一个 concept
  const seen = new Map<string, number>()

  for (const item of rawUnits) {
    if (typeof item !== 'object' || item === null) continue
    const u = item as Record<string, unknown>

    const groupIndex = typeof u.group === 'number' ? u.group : -1
    const group = groups[groupIndex]
    // group 序号非法 → 无法归因来源，直接丢弃
    if (!group) continue

    const candidate = normalizeCandidateUnit({
      ...u,
      kind: group.kind,
      sourceItemIds: group.itemIds,
    })
    if (!candidate) continue

    const key = `${candidate.concept}|${candidate.kind}`
    const existing = seen.get(key)
    if (existing !== undefined) {
      // 同一概念重复出现：并来源，保留置信度更高的表述
      const prev = out[existing]
      prev.sourceItemIds = Array.from(
        new Set([...prev.sourceItemIds, ...candidate.sourceItemIds])
      )
      if (candidate.confidence > prev.confidence) {
        prev.claim = candidate.claim
        prev.confidence = candidate.confidence
        prev.domainScope = candidate.domainScope
      }
      continue
    }

    seen.set(key, out.length)
    out.push(candidate)
  }

  return { units: out, degraded: false }
}

// ── 4. 编排 ───────────────────────────────────────────────

export interface BuildCandidatesResult extends AggregateResult {
  /** 阶段 A 产生的合格分组数（degraded 时用于区分「没候选」和「LLM 挂了」） */
  groupCount: number
}

export async function buildCandidateUnits(
  refs: ClaimRef[],
  opts?: AggregateOptions
): Promise<BuildCandidatesResult> {
  const groups = groupClaims(refs, opts)
  const { units, degraded } = await aggregateUnits(groups)
  return { units, degraded, groupCount: groups.length }
}
