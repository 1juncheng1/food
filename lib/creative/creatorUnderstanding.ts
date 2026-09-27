// ============================================================
// Creator Understanding —— 「此刻系统对这个用户理解了多少」的唯一读取口径
//
// 存在理由（不建这个模块会怎样）：
//   Creator Intelligence 的六路资产分散在 style_profiles 的不同列里，
//   由 5 个子系统各自读写、各自有一套置信度与降级规则。结果是：
//   「AI 有多懂这个用户」这个问题此前至少有两套答案 ——
//     · /api/creator-status：按 作品/反馈/素材/建档 四路线性计分
//     · dashboard：直接读 interest_profile.identity.completeness
//   两套口径并存，用户在不同页面看到的百分比不一样，且都没有回答
//   「哪一路还缺数据、补什么最有价值」。
//
// 本模块把这六路收口成一个纯函数：给定已读出的原始列，输出
//   · readiness/percent/level（单一口径的理解度）
//   · 每一路的 present / confidence / samples / updatedAt
//   · 按权重排序的缺口提示（用于「让 AI 更懂你」的引导，而不是给个空泛百分比）
//
// 设计铁律：
//   1. 纯函数：不读库、不调 LLM、不写库。调用方负责把原始列取出来传进来，
//      代价是调用方多传几个字段，收益是本模块可在任意路由/测试里零成本复用。
//   2. 诚实优先：没有数据就是 0，绝不用默认值把新用户包装成"已理解"。
//   3. 置信度一律由代码计算（样本量/填满度），不采信任何 AI 自报的数字。
//   4. 权重与阈值集中在下方常量区，禁止散落魔法数。
// ============================================================

import {
  CORE_DIMENSIONS,
  IDENTITY_DIMENSIONS,
  isDeclarationEmpty,
  isDimensionFilled,
  normalizeCreatorDeclaration,
} from './creatorDeclaration'
import { parseCreatorReport } from './creatorReport'
import { parseStyleDimensions } from './styleLearning'
import { parseEditingProfile } from './editingMemory'
import { normalizeInterestProfile } from './interest/promptBlock'
import { CREATOR_LEVEL_META, type CreatorLevel } from './creatorStatus'

// ── 常量区（改数字 = 口径变更，必须同步更新测试基线）──────────────

/**
 * 六路信号在总理解度中的权重，合计 1.0。
 * 定权依据：memory（用户主动声明）与 report（AI 版本化 DNA）是「我是谁」的两根支柱，
 * interest（长期关注）决定「写什么」，knowledge 决定「凭什么写」，
 * style / editing 是行为层修正，样本本就稀疏（真实定稿率 7%），权重刻意压低。
 */
export const LAYER_WEIGHTS = {
  memory: 0.24,
  report: 0.2,
  knowledge: 0.16,
  interest: 0.2,
  style: 0.1,
  editing: 0.1,
} as const

/** 各路「置信度达到满格」所需样本量 */
const FULL_SAMPLES = {
  knowledge: 6, // 已确认知识单元条数
  style: 10, // 风格画像加权样本数
  editing: 10, // 编辑偏好事件数
} as const

/** 等级门槛（与 creatorStatus 的 40/75 分档保持同一手感） */
const LEVEL_THRESHOLD = {
  ready: 0.7,
  learning: 0.35,
} as const

/**
 * 「我是谁」三问（经历 / 价值判断 / 长期目标）每填一维的加分。
 *
 * 刻意做成"加分"而不是"进分母"：三问是后加的维度，若进分母，
 * 已访谈老用户会因为我们升级系统而一夜之间理解度下降 —— 那是把系统需求
 * 转嫁给用户。加分只让原本不完整的人变高，不让已满格的人变低。
 */
const IDENTITY_DIMENSION_BONUS = 0.05

// ── 类型 ───────────────────────────────────────────────────

export type UnderstandingLayerKey = keyof typeof LAYER_WEIGHTS

export interface UnderstandingLayer {
  key: UnderstandingLayerKey
  /** 中文名（页面直接渲染，不各处重复翻译） */
  label: string
  /** 该路是否有可用数据 */
  present: boolean
  /** 0~1：该路自身的置信度（无数据恒为 0） */
  confidence: number
  /** 该路已吸收的样本数（无量纲统一的原始计数，仅用于展示与排障） */
  samples: number
  updatedAt: string
  /** 该路缺失/不足时，给用户的诚实引导语 */
  gapHint: string
}

/** 调用方传入的原始列（全部可缺省：未迁移 / 未建模 / 查库失败都按"没有"处理） */
export interface UnderstandingInput {
  /** style_profiles.creator_declaration（用户主动声明） */
  declaration?: unknown
  /** style_profiles.creator_report（AI 版本化 DNA 报告） */
  report?: unknown
  /** style_profiles.interest_profile（CIP 兴趣画像） */
  interestProfile?: unknown
  /** style_profiles.style_dimensions（五维风格画像） */
  styleDimensions?: unknown
  /** style_profiles.editing_profile（编辑偏好记忆） */
  editingProfile?: unknown
  /**
   * 已确认的知识单元条数。
   * 读层不碰库，这一路必须由调用方查 creator_knowledge 后传入；
   * 传 undefined 表示调用方没查（按 0 处理，绝不猜）。
   */
  confirmedKnowledge?: number
}

export interface CreatorUnderstandingSnapshot {
  /** 0~1 加权总理解度 */
  readiness: number
  /** 0~100 整数（页面展示口径） */
  percent: number
  level: CreatorLevel
  /** 六路明细，顺序固定（= 权重降序），便于页面稳定渲染 */
  layers: UnderstandingLayer[]
  /** 当前最值得补的一路（全部就绪时为 null） */
  nextGap: UnderstandingLayerKey | null
  /** 直接可渲染的引导语（nextGap 为 null 时为 null） */
  nextGapHint: string | null
}

// ── 各路元数据（文案唯一出处）────────────────────────────────

const LAYER_META: Record<UnderstandingLayerKey, { label: string; gapHint: string }> = {
  memory: {
    label: '创作者声明',
    gapHint: '完成创作者访谈，告诉 AI 你为什么而写、排斥什么',
  },
  report: {
    label: '创作 DNA 报告',
    gapHint: '再创作几篇并点「让 AI 重新理解我」，生成你的创作 DNA',
  },
  knowledge: {
    label: '知识资产',
    gapHint: '在素材库沉淀内容，并把 AI 归纳的观点确认为「我的知识」',
  },
  interest: {
    label: '长期关注领域',
    gapHint: '继续创作与互动，AI 正在归纳你长期关注的领域',
  },
  style: {
    label: '风格画像',
    gapHint: '对满意的作品点赞或定稿，AI 才能学到你要的标准',
  },
  editing: {
    label: '修改偏好',
    gapHint: '用 AI 共创修改作品，AI 会记住你接受与拒绝的改法',
  },
}

/** 页面/接口渲染顺序：权重降序（缺数据的一路排前面更利于引导，故按权重而非是否命中排序） */
const LAYER_ORDER: UnderstandingLayerKey[] = ['memory', 'interest', 'report', 'knowledge', 'style', 'editing']

// ── 内部小工具 ─────────────────────────────────────────────

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

function sampleConfidence(samples: number, full: number): number {
  if (!Number.isFinite(samples) || samples <= 0) return 0
  return clamp01(samples / full)
}

// ── 主函数 ─────────────────────────────────────────────────

/**
 * 聚合六路信号，输出统一理解度快照。
 * 任何一路数据损坏/缺失都按"没有"处理，绝不抛异常、绝不返回 NaN。
 */
export function readCreatorUnderstanding(
  input: UnderstandingInput
): CreatorUnderstandingSnapshot {
  // 1) memory：用户主动声明
  //    核心 8 维决定基础置信度，「我是谁」三问按条加分（见 IDENTITY_DIMENSION_BONUS）。
  const declaration = normalizeCreatorDeclaration(input.declaration)
  const memoryAnswered = CORE_DIMENSIONS.filter((k) =>
    isDimensionFilled(declaration, k)
  ).length
  const identityAnswered = IDENTITY_DIMENSIONS.filter((k) =>
    isDimensionFilled(declaration, k)
  ).length
  const memoryPresent = !isDeclarationEmpty(declaration)
  const memoryLayer: UnderstandingLayer = {
    key: 'memory',
    label: LAYER_META.memory.label,
    present: memoryPresent,
    confidence: memoryPresent
      ? clamp01(
          memoryAnswered / CORE_DIMENSIONS.length +
            IDENTITY_DIMENSION_BONUS * identityAnswered
        )
      : 0,
    samples: memoryAnswered + identityAnswered,
    updatedAt: declaration.interviewedAt ?? '',
    gapHint: LAYER_META.memory.gapHint,
  }

  // 2) report：AI 版本化 DNA 报告（置信度由报告自身携带，代码算出、非 AI 自夸）
  const report = parseCreatorReport(input.report)
  const reportLayer: UnderstandingLayer = {
    key: 'report',
    label: LAYER_META.report.label,
    present: !!report,
    confidence: report ? clamp01(report.confidence) : 0,
    samples: report?.sampleCount ?? 0,
    updatedAt: report?.updatedAt ?? '',
    gapHint: LAYER_META.report.gapHint,
  }

  // 3) knowledge：已确认的知识单元（条数由调用方传入）
  const knowledgeCount =
    typeof input.confirmedKnowledge === 'number' && input.confirmedKnowledge > 0
      ? Math.floor(input.confirmedKnowledge)
      : 0
  const knowledgeLayer: UnderstandingLayer = {
    key: 'knowledge',
    label: LAYER_META.knowledge.label,
    present: knowledgeCount > 0,
    confidence: sampleConfidence(knowledgeCount, FULL_SAMPLES.knowledge),
    samples: knowledgeCount,
    updatedAt: '',
    gapHint: LAYER_META.knowledge.gapHint,
  }

  // 4) interest：CIP 兴趣画像（completeness 由 profileAssembly 计算）
  const interest = normalizeInterestProfile(input.interestProfile)
  const interestLayer: UnderstandingLayer = {
    key: 'interest',
    label: LAYER_META.interest.label,
    present: !!interest,
    confidence: interest ? clamp01(interest.completeness) : 0,
    samples: interest?.topicInterest.length ?? 0,
    updatedAt: '',
    gapHint: LAYER_META.interest.gapHint,
  }

  // 5) style：五维风格画像（样本 <2 时 styleLearning 自身就不注入，此处同步视为未就绪）
  const styleState = parseStyleDimensions(input.styleDimensions)
  const styleReady = styleState.samples >= 2
  const styleLayer: UnderstandingLayer = {
    key: 'style',
    label: LAYER_META.style.label,
    present: styleReady,
    confidence: styleReady ? sampleConfidence(styleState.samples, FULL_SAMPLES.style) : 0,
    samples: Math.round(styleState.samples * 10) / 10,
    updatedAt: styleState.updatedAt,
    gapHint: LAYER_META.style.gapHint,
  }

  // 6) editing：编辑偏好记忆（与 style 同口径，样本 <2 不注入即未就绪）
  const editingState = parseEditingProfile(input.editingProfile)
  const editingReady = editingState.samples >= 2
  const editingLayer: UnderstandingLayer = {
    key: 'editing',
    label: LAYER_META.editing.label,
    present: editingReady,
    confidence: editingReady
      ? sampleConfidence(editingState.samples, FULL_SAMPLES.editing)
      : 0,
    samples: editingState.samples,
    updatedAt: editingState.updatedAt,
    gapHint: LAYER_META.editing.gapHint,
  }

  const byKey: Record<UnderstandingLayerKey, UnderstandingLayer> = {
    memory: memoryLayer,
    report: reportLayer,
    knowledge: knowledgeLayer,
    interest: interestLayer,
    style: styleLayer,
    editing: editingLayer,
  }
  const layers = LAYER_ORDER.map((k) => byKey[k])

  // 加权总理解度：只对 present 的路计分（没有数据就是 0，不用默认值填充）
  let readiness = 0
  for (const layer of layers) {
    readiness += LAYER_WEIGHTS[layer.key] * layer.confidence
  }
  readiness = clamp01(readiness)
  const percent = Math.round(readiness * 100)

  const level: CreatorLevel =
    readiness >= LEVEL_THRESHOLD.ready
      ? 'ready'
      : readiness >= LEVEL_THRESHOLD.learning
        ? 'learning'
        : 'forming'

  // 缺口：缺数据的路里权重最高的那条（全部就绪则 null）
  const missing = layers
    .filter((l) => !l.present)
    .sort((a, b) => LAYER_WEIGHTS[b.key] - LAYER_WEIGHTS[a.key])
  const nextGap = missing.length > 0 ? missing[0].key : null

  return {
    readiness,
    percent,
    level,
    layers,
    nextGap,
    nextGapHint: nextGap ? LAYER_META[nextGap].gapHint : null,
  }
}

/** 页面展示用的等级文案（复用 creatorStatus 的唯一出处，避免三处漂移） */
export function understandingLevelMeta(level: CreatorLevel) {
  return CREATOR_LEVEL_META[level]
}
