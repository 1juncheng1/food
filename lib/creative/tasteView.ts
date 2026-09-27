// ============================================================
// Taste View —— 「这个用户喜欢什么 / 不要什么」的合成视图（运行时派生）
//
// 存在理由（不建这个模块会怎样）：
//   「喜欢 / 不喜欢」的信号此前散在四处，各自表达、各自有置信度：
//     · creator_declaration.avoid_preference  用户主动声明的硬禁忌
//     · creator_report.bounds                 AI 从作品素材归纳的喜欢/回避
//     · editing_profile.preferences           用户真实接受/拒绝过的改法
//     · interest_profile.topicInterest        行为统计出的长期关注领域
//   四处都是"同一件事的不同证据"，却没有任何一处能回答
//   「综合来看，这位创作者喜欢什么」——也没有一处能给用户看、让用户纠正。
//
// 本模块把四路合成一个视图：**每条信号都带来源与置信度**，
// 同源信号合并、异源信号互相印证（置信度叠加）。
//
// 设计铁律：
//   1. 运行时派生，不落库。落库就要解决四路写入时的并发覆盖 —— 那是
//      style_profiles 列堆叠的老问题，绝不再复制一次。需要时重算即可。
//   2. 用户声明是权威：declaration 来源的信号**不设置信度门槛**，
//      用户亲口说的就是事实，不需要"攒够样本才敢信"。
//   3. 行为信号必须过门槛：单次行为不能定性用户（真实定稿率仅 7%，
//      样本本就稀疏），低于 MIN_CONFIDENCE 的一律不进视图。
//   4. 本视图**不注入 prompt**：editing 原始块（含修改原话）已经进了生成链路，
//      再注入一份合成版等于同一信息说两遍，既挤上下文又可能自相矛盾。
//      它的消费者是：① /style-profile 让用户看见并可纠正 ② 一致性诊断三问。
// ============================================================

import {
  isDeclarationEmpty,
  normalizeCreatorDeclaration,
  type CreatorDeclaration,
} from './creatorDeclaration'
import { parseCreatorReport } from './creatorReport'
import { parseEditingProfile } from './editingMemory'
import { parseStyleDimensions, type StyleDimensionsState } from './styleLearning'
import { normalizeInterestProfile } from './interest/promptBlock'
// 从 diagnosisMeta 直接取，不要经过 ./diagnosis：
// diagnosis 会连带拉进 @/lib/llm → aiDeadline → node:async_hooks，
// 而本模块被 'use client' 页面（/style-profile）导入，
// 那条链会让生产构建在浏览器 chunk 阶段直接失败。
import { DIMENSION_META } from './diagnosisMeta'

// ── 常量区（改数字 = 口径变更）──────────────────────────────

/**
 * 行为信号进入视图的最低置信度。
 * 0.3 ≈ 至少两三次一致的行为（editing 单事件的拉升步长约 0.15~0.2）。
 * declaration 来源豁免此门槛（见铁律 2）。
 */
const MIN_CONFIDENCE = 0.3

/** 兴趣强度低于此值不视为"喜欢"（长期关注 ≠ 喜欢，且要滤掉长尾噪声） */
const MIN_INTEREST_WEIGHT = 30

/** 每个极性最多保留的信号条数（视图是给人看的，不是给机器全量灌的） */
const MAX_SIGNALS_PER_POLARITY = 8

/** 深度取向的分档门槛（0~1） */
const DEPTH_THRESHOLD = { deep: 0.7, plain: 0.35 } as const

// ── 类型 ───────────────────────────────────────────────────

/** 信号来源（视图里每条信号都要能追溯到出处） */
export type TasteSource = 'declaration' | 'report' | 'editing' | 'interest'

export const TASTE_SOURCE_LABEL: Record<TasteSource, string> = {
  declaration: '你主动声明的',
  report: 'AI 从你的作品归纳',
  editing: '你在修改中表达的',
  interest: '从你的创作行为统计',
}

export interface TasteSignal {
  /** 偏好陈述（人可读，如"空洞鸡汤""真实案例"） */
  statement: string
  /** like = 喜欢/想要的；avoid = 不要的 */
  polarity: 'like' | 'avoid'
  /** 0~1：多源合并后的置信度 */
  confidence: number
  /** 证据来源（可能多个，互相印证） */
  sources: TasteSource[]
  /** 人可读的证据说明（展示用，让用户知道"凭什么这么说"） */
  evidence: string
}

export interface TasteDepth {
  /** 0~1：用户满意的成品在五维上的平均水准 */
  level: number
  label: '偏平实' | '中等' | '偏深入'
  /** 行为样本数（<2 时本视图不产出 depth） */
  samples: number
}

export interface TasteView {
  likes: TasteSignal[]
  avoids: TasteSignal[]
  /** 内容深度取向（由五维行为画像派生，样本不足时为 null） */
  depth: TasteDepth | null
  /** 是否有任何一条可用信号（决定 UI 是否展示该区块） */
  hasAny: boolean
}

/** 输入：style_profiles 的原始列（全部可缺省） */
export interface TasteInput {
  declaration?: unknown
  report?: unknown
  editingProfile?: unknown
  interestProfile?: unknown
  styleDimensions?: unknown
}

// ── 内部工具 ───────────────────────────────────────────────

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

/** 陈述归一（合并同源信号用：去空白与常见标点） */
function normalizeKey(s: string): string {
  return s.replace(/[\s，。！？；：、,.!?;:'"()（）]/g, '').toLowerCase()
}

/**
 * 多源置信度合并（noisy-OR）。
 * 两条独立证据各自 0.5 → 合并 0.75：互相印证应当更强，但永远到不了 1
 * （创作口味本就持续演化，任何置信度都不该是确证）。
 */
function mergeConfidence(values: number[]): number {
  let miss = 1
  for (const v of values) miss *= 1 - clamp01(v)
  return clamp01(1 - miss)
}

interface RawSignal {
  statement: string
  polarity: 'like' | 'avoid'
  confidence: number
  source: TasteSource
  evidence: string
}

/** 把原始信号按 (极性, 归一陈述) 合并 */
function mergeSignals(raws: RawSignal[]): TasteSignal[] {
  const buckets = new Map<string, RawSignal[]>()
  for (const r of raws) {
    const key = `${r.polarity}:${normalizeKey(r.statement)}`
    const list = buckets.get(key)
    if (list) list.push(r)
    else buckets.set(key, [r])
  }

  const merged: TasteSignal[] = []
  for (const list of buckets.values()) {
    const first = list[0]
    const confidence = mergeConfidence(list.map((r) => r.confidence))
    const sources = [...new Set(list.map((r) => r.source))]
    // 门槛：用户声明豁免，行为信号必须达标
    if (confidence < MIN_CONFIDENCE && !sources.includes('declaration')) continue
    merged.push({
      statement: first.statement,
      polarity: first.polarity,
      confidence,
      sources,
      // 多条证据时拼起来展示，让用户看到"不是一次行为就定性"
      evidence: list.map((r) => r.evidence).join('；'),
    })
  }

  return merged
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_SIGNALS_PER_POLARITY)
}

/** 声明类硬禁忌可能用「、」分隔多条，逐条拆开 */
function splitStatements(v: string): string[] {
  return v
    .split(/[、,，]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length <= 50)
}

// ── 各路信号采集 ───────────────────────────────────────────

function fromDeclaration(d: CreatorDeclaration): RawSignal[] {
  if (isDeclarationEmpty(d)) return []
  const out: RawSignal[] = []
  if (d.avoid_preference) {
    for (const s of splitStatements(d.avoid_preference)) {
      out.push({
        statement: s,
        polarity: 'avoid',
        confidence: 1,
        source: 'declaration',
        evidence: '你在访谈/设置中明确排除',
      })
    }
  }
  return out
}

function fromReport(raw: unknown): RawSignal[] {
  const report = parseCreatorReport(raw)
  if (!report) return []
  const out: RawSignal[] = []
  for (const s of report.bounds?.favorite ?? []) {
    out.push({
      statement: s,
      polarity: 'like',
      confidence: clamp01(report.confidence),
      source: 'report',
      evidence: `分析了你的 ${report.sampleCount} 篇作品与素材`,
    })
  }
  for (const s of report.bounds?.avoid ?? []) {
    out.push({
      statement: s,
      polarity: 'avoid',
      confidence: clamp01(report.confidence),
      source: 'report',
      evidence: `分析了你的 ${report.sampleCount} 篇作品与素材`,
    })
  }
  return out
}

function fromEditing(raw: unknown): RawSignal[] {
  const state = parseEditingProfile(raw)
  // 与注入同口径：样本 <2 时 editingMemory 自身就不注入，这里也不该产出信号
  if (state.samples < 2) return []
  return state.preferences.map((p) => ({
    statement: p.statement,
    polarity: p.type,
    confidence: clamp01(p.confidence),
    source: 'editing' as const,
    evidence:
      p.type === 'like'
        ? `你在修改中接受过 ${p.sourceCount} 次`
        : `你在修改中拒绝过 ${p.sourceCount} 次`,
  }))
}

function fromInterest(raw: unknown): RawSignal[] {
  const snapshot = normalizeInterestProfile(raw)
  if (!snapshot) return []
  return snapshot.topicInterest
    .filter((t) => t.weight >= MIN_INTEREST_WEIGHT)
    .map((t) => ({
      statement: t.name,
      polarity: 'like' as const,
      confidence: clamp01(t.weight / 100),
      source: 'interest' as const,
      evidence: t.reason ? `长期关注（${t.reason}）` : `长期关注（强度 ${t.weight}/100）`,
    }))
}

/** 内容深度取向：由五维行为画像的平均值派生 */
function depthFromStyle(state: StyleDimensionsState): TasteDepth | null {
  if (state.samples < 2) return null
  const values = DIMENSION_META.map((m) => state.dims[m.key]).filter(
    (v): v is number => typeof v === 'number'
  )
  if (values.length === 0) return null
  const level = values.reduce((a, b) => a + b, 0) / values.length
  return {
    level: clamp01(level),
    label:
      level >= DEPTH_THRESHOLD.deep
        ? '偏深入'
        : level <= DEPTH_THRESHOLD.plain
          ? '偏平实'
          : '中等',
    samples: Math.round(state.samples * 10) / 10,
  }
}

// ── 主函数 ─────────────────────────────────────────────────

/**
 * 合成 taste 视图（纯函数）。
 * 任何一路数据缺失/损坏都按"没有"处理，绝不抛异常。
 */
export function buildTasteView(input: TasteInput): TasteView {
  const declaration = normalizeCreatorDeclaration(input.declaration)
  const raws: RawSignal[] = [
    ...fromDeclaration(declaration),
    ...fromReport(input.report),
    ...fromEditing(input.editingProfile),
    ...fromInterest(input.interestProfile),
  ]

  const all = mergeSignals(raws)
  const likes = all.filter((s) => s.polarity === 'like')
  const avoids = all.filter((s) => s.polarity === 'avoid')
  const depth = depthFromStyle(parseStyleDimensions(input.styleDimensions))

  return {
    likes,
    avoids,
    depth,
    hasAny: likes.length > 0 || avoids.length > 0 || depth !== null,
  }
}
