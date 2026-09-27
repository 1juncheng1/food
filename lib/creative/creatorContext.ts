// ============================================================
// Creator Context —— 生成链路的「个人数据注入装配器」
//
// 存在理由（不建这个模块会怎样）：
//   此前三个生成入口各自手拼个人数据块：
//     plan/route.ts        buildStyleProfileText()
//     blueprint/route.ts   内联拼装
//     prompt-optimizer     内联拼装
//   三处口径靠注释维系，已经漂移过两次：
//     1. interest_profile 曾长期只进正文，方案/蓝图看不到「用户关注什么」；
//     2. editing_profile（用户接受/拒绝过的改法）至今只进正文与补丁链路，
//        方案与蓝图阶段的 AI 依然不知道这位创作者反复拒绝什么。
//   根因不是谁写错了，而是「哪些块该注入」这件事没有唯一出处。
//
// 本模块把「我的模式注入哪些块、按什么顺序、各自多少预算、哪些是硬禁忌」
// 收口为一个纯函数，三处调用它，漂移从"靠人记住"变成"结构上不可能"。
//
// 设计铁律：
//   1. 纯函数：不读库、不调 LLM。素材/知识这类需要异步检索的块仍由各路由
//      按自身语义处理（它们的召回口径本就不同），本模块只管 profile 派生块。
//   2. 阶段措辞可配，块集合不可配：路由只能改"请在蓝图中体现…"这类指令句，
//      不能偷偷少注入一块 —— 少注入正是此前漂移的形态。
//   3. 优先级：用户主动声明 > AI 推断人格 > 用户修改行为 > 行为统计观察。
//      越靠前越权威，截断时从最低优先级开始放弃。
//   4. 空块整块剔除，未建模用户零字数开销。
//   5. 硬禁忌（avoid）单独成数组返回，由调用方写入生成硬规则 —— 混在正文里
//      只是"建议"，分开才是能真正生效的约束。
// ============================================================

import { formatStyleDimensions } from './styleLearning'
import { formatCreatorModel, type AppliedTrait } from './creatorModel'
import {
  extractDeclarationTraits,
  formatDeclarationForPrompt,
  isDeclarationEmpty,
  normalizeCreatorDeclaration,
  type DeclarationTrait,
} from './creatorDeclaration'
import { formatEditingProfileForPrompt, parseEditingProfile } from './editingMemory'
import { buildInterestBlock, type InterestPromptOptions } from './interest/promptBlock'

// ── 常量区（改数字 = 注入口径变更）────────────────────────────

/**
 * 单块字符上限。目的是给 prompt 设天花板，避免某块无限膨胀挤掉主题与素材；
 * 常规数据远达不到这些值（声明每维限 200 字 × 8 维）。
 * 超过上限从块尾截断并显式标注，绝不静默丢弃整块。
 */
const BLOCK_MAX_CHARS = {
  personality: 2600,
  declaration: 2000,
  editing: 1500,
} as const

/** 阶段专属指令句：同一份数据在不同阶段要 AI 做的事不同 */
const STAGE_INSTRUCTION = {
  plan: {
    style: '请在三个方向的设计中体现这些风格特征（方向可有探索性，但推荐方向必须贴合）。',
    creator:
      '请在方向的选题切入、Hook 与核心冲突上体现该创作者的母题偏好与人格气质；排斥元素不得出现在任何方向的任何环节。',
  },
  blueprint: {
    style: '请在蓝图中体现这些风格特征。',
    creator:
      '请在蓝图的主题定位、Hook 与核心冲突选取上体现该创作者的母题偏好与人格气质；排斥元素不得出现在蓝图任何环节。',
  },
  article: {
    style: '请尽量体现这些风格特征。',
    creator: '',
  },
} as const

// ── 类型 ───────────────────────────────────────────────────

/** 装配阶段（决定指令措辞，不影响块集合） */
export type CreatorContextStage = keyof typeof STAGE_INSTRUCTION

/** 装配器消费的 style_profiles 原始列（全部可选：缺列即降级为"没有"） */
export interface CreatorContextProfile {
  tone_tags?: unknown
  pace_preference?: unknown
  common_opening?: unknown
  avg_length?: unknown
  style_dimensions?: unknown
  creator_personality?: unknown
  topic_preferences?: unknown
  favorite_elements?: unknown
  avoid_elements?: unknown
  ai_creator_summary?: unknown
  creator_report?: unknown
  creator_declaration?: unknown
  editing_profile?: unknown
  interest_profile?: unknown
}

export interface CreatorContextOptions {
  stage: CreatorContextStage
  /** 兴趣块预算（方案/蓝图阶段上下文更紧张，调用方可收紧） */
  interest?: InterestPromptOptions
  /**
   * 是否注入编辑偏好记忆。
   * 默认 true —— 三阶段一致正是本次修复的目标；仅排查注入问题时才关。
   */
  includeEditing?: boolean
}

export interface CreatorContextBlocks {
  /** 风格统计 + 五维画像（含阶段指令句） */
  styleText: string
  /** 人格 + 声明 + 编辑偏好（按优先级排序，含阶段指令句） */
  creatorText: string
  /** 长期关注领域（各阶段自行决定是否并入 styleText/creatorText） */
  interestText: string
  /** 硬禁忌合集：人格排斥 + 声明排斥 + 高置信拒绝过的改法 */
  avoid: string[]
  /** 实际生效的注入层标签（供 PersonalizationEvidence 展示"本次参考了什么"） */
  layers: string[]
  /** 本次生效的创作者声明维度（供前端展示） */
  declarationTraits: DeclarationTrait[]
  /** 本次采用的创作者特征（仅 DNA 报告分支有值，散列回退为空数组） */
  traits: AppliedTrait[]
}

// ── 内部小工具 ─────────────────────────────────────────────

/** 超限从块尾截断并显式标注（比静默丢整块诚实，也便于日志排障） */
function cap(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…（本块过长已截断）`
}

function joinBlocks(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).join('\n\n')
}

// ── 主函数 ─────────────────────────────────────────────────

/**
 * 装配「我的模式」的个人数据注入块。
 *
 * @param profile style_profiles 原始行（灵感模式传 null 即可，返回全空）
 * @param options 阶段措辞与兴趣预算
 */
export function buildCreatorContextBlocks(
  profile: CreatorContextProfile | null | undefined,
  options: CreatorContextOptions
): CreatorContextBlocks {
  const empty: CreatorContextBlocks = {
    styleText: '',
    creatorText: '',
    interestText: '',
    avoid: [],
    layers: [],
    declarationTraits: [],
    traits: [],
  }
  if (!profile || typeof profile !== 'object') return empty

  const instruction = STAGE_INSTRUCTION[options.stage]
  const layers: string[] = []
  const avoid: string[] = []
  const pushAvoid = (items: string[]) => {
    for (const item of items) {
      const v = typeof item === 'string' ? item.trim() : ''
      if (v && !avoid.includes(v)) avoid.push(v)
    }
  }

  // ── 1) 风格统计 + 五维行为画像 ──────────────────────────
  const toneTags =
    Array.isArray(profile.tone_tags) && profile.tone_tags.length
      ? profile.tone_tags.filter((x): x is string => typeof x === 'string').join('、')
      : '暂无'
  const learnedDims = formatStyleDimensions(profile.style_dimensions)
  if (learnedDims) layers.push('五维风格画像')

  const styleText = `【用户的创作风格特征】
语气：${toneTags}
节奏：${typeof profile.pace_preference === 'string' ? profile.pace_preference : '未知'}
常用开头：${typeof profile.common_opening === 'string' ? profile.common_opening : '未知'}
平均长度：${typeof profile.avg_length === 'number' ? profile.avg_length : 0} 字/篇
${instruction.style}${learnedDims ? `\n${learnedDims}` : ''}`

  // ── 2) 创作者人格（AI 推断：9.6 DNA 报告优先，回退 9.5 散列）──
  const modelBlock = formatCreatorModel(profile)
  const personalityText = modelBlock.text ? cap(modelBlock.text.trim(), BLOCK_MAX_CHARS.personality) : ''
  if (personalityText) {
    pushAvoid(modelBlock.avoid)
    layers.push(...modelBlock.layers)
  }

  // ── 3) 创作者声明（用户主动表达，优先级高于 AI 推断）──────
  const declaration = normalizeCreatorDeclaration(profile.creator_declaration)
  const declarationText = isDeclarationEmpty(declaration)
    ? ''
    : cap(formatDeclarationForPrompt(declaration).trim(), BLOCK_MAX_CHARS.declaration)
  const declarationTraits: DeclarationTrait[] = declarationText
    ? extractDeclarationTraits(declaration)
    : []
  if (declarationText) {
    layers.push('创作者声明')
    if (declaration.avoid_preference) pushAvoid([declaration.avoid_preference])
  }

  // ── 4) 编辑偏好记忆（用户真实接受/拒绝过的改法）────────────
  // 此前只进正文与补丁链路，方案/蓝图阶段的 AI 看不到用户反复拒绝什么，
  // 正是"方向由主题定、文笔才由人定"的另一半成因。这里统一补上。
  const editingState = parseEditingProfile(profile.editing_profile)
  const editingText =
    options.includeEditing === false
      ? ''
      : cap(formatEditingProfileForPrompt(editingState).trim(), BLOCK_MAX_CHARS.editing)
  if (editingText) {
    layers.push('修改偏好记忆')
    for (const p of editingState.preferences) {
      if (p.type === 'avoid' && p.sourceCount >= 2) pushAvoid([p.statement])
    }
  }

  // ── 5) 长期关注领域（行为统计观察，软参考、非硬约束）────────
  const interestText = buildInterestBlock(profile.interest_profile, options.interest).text
  if (interestText) layers.push('长期关注领域')

  const creatorBody = joinBlocks([personalityText, declarationText, editingText])

  return {
    styleText,
    creatorText: creatorBody
      ? `${creatorBody}${instruction.creator ? `\n\n${instruction.creator}` : ''}`
      : '',
    interestText,
    avoid,
    layers,
    declarationTraits,
    traits: modelBlock.traits,
  }
}
