// ============================================================
// Creator Model —— 创作者人格 → Prompt 注入文本 + 透明化证据
//
// 设计原则：
// 1. 9.6 creator_report（结构化 DNA 报告）优先；缺失时回退 9.5 散列人格；
// 2. avoid_elements 是硬禁忌，在调用处还需进入生成硬规则；
// 3. 题材偏好只在"与本次主题相关"时影响方向，不得覆盖用户本次输入；
// 4. 空人格（新用户）返回空串，调用处整块剔除，游客链路零影响；
// 5. 本模块只做文本格式化，不读库，可在任意服务端路由复用。
// ============================================================

import {
  formatCreatorReportForPrompt,
  parseCreatorReport,
  type AppliedTrait,
} from './creatorReport'
import type { CreationMode } from './personalization'

export type { AppliedTrait }

/** 人格原始字段（对应 style_profiles 9.5/9.6 节列） */
export interface CreatorModelRaw {
  creator_personality?: unknown
  topic_preferences?: unknown
  favorite_elements?: unknown
  avoid_elements?: unknown
  ai_creator_summary?: unknown
  /** 9.6 版本化创作 DNA 报告（存在时优先于散列） */
  creator_report?: unknown
}

/** 本次生成实际用到的个性化证据（返回给前端展示，不暴露 prompt 本身） */
export interface PersonalizationEvidence {
  /** 本次创作模式（灵感/我的）；article 页据此区分"通用生成"与"积累中"提示 */
  mode: CreationMode
  /** 我的模式是否启用（灵感模式恒为 false） */
  enabled: boolean
  /** 实际生效的个性化层（中文短标签，前端直接渲染） */
  layers: string[]
  /** 向量检索命中的素材库条数 */
  materialCount: number
  /** 五维风格画像的行为样本数（不足 2 时画像未注入） */
  dimensionSamples: number
  /** 第七阶段：本篇与用户历史风格向量的真实一致度（余弦相似度 0-1；无向量时缺省） */
  styleMatch?: number
  /** 第七阶段：本次实际采用的创作者特征（DNA 真实统计，无报告时为空） */
  traits?: AppliedTrait[]
}

function strArr(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : []
}

/**
 * 报告优先：creator_report 是一次 AI 分析的完整结构化产物（主/副人格、
 * 母题/叙事 DNA、语言特质、证据计数），信息量与时效性都高于 9.5 散列；
 * 报告缺失（老用户/未迁移）时回退散列人格块。
 */
function formatFromReport(raw: CreatorModelRaw): CreatorModelBlock | null {
  const report = parseCreatorReport(raw.creator_report)
  if (!report) return null
  // 用户手动命名优先于 AI 命名（报告里的 main 仍保留为 AI 建议，仅注入时让位）
  const manualName =
    typeof raw.creator_personality === 'string' ? raw.creator_personality.trim() : ''
  const effectiveReport = manualName
    ? { ...report, personality: { ...report.personality, main: manualName, sub: '' } }
    : report
  const block = formatCreatorReportForPrompt(effectiveReport)
  return block.text ? block : null
}

export interface CreatorModelBlock {
  /** 注入 prompt 的人格块文本；无任何人格数据时为空串 */
  text: string
  /** 硬禁忌元素（调用处需要单独写进生成硬规则） */
  avoid: string[]
  /** 实际生效的人格层标签 */
  layers: string[]
  /** 第七阶段：本次采用的创作者特征（仅 DNA 报告分支有值，散列回退为空数组） */
  traits: AppliedTrait[]
}

/**
 * 把 style_profiles 的 Creator Model 列格式化为 prompt 文本块。
 * 纯函数；所有字段为空时返回 { text: '', avoid: [], layers: [] }。
 */
export function formatCreatorModel(raw: CreatorModelRaw | null | undefined): CreatorModelBlock {
  if (!raw || typeof raw !== 'object') return { text: '', avoid: [], layers: [], traits: [] }

  // 9.6 结构化 DNA 报告优先（主/副人格 + 带证据计数的母题/叙事/语言）
  const reportBlock = formatFromReport(raw)
  if (reportBlock) return reportBlock

  // 回退：9.5 散列人格（老用户/未生成报告）
  const personality =
    typeof raw.creator_personality === 'string' ? raw.creator_personality.trim() : ''
  const summary =
    typeof raw.ai_creator_summary === 'string' ? raw.ai_creator_summary.trim() : ''
  const topics = strArr(raw.topic_preferences).slice(0, 15)
  const favorites = strArr(raw.favorite_elements).slice(0, 15)
  const avoid = strArr(raw.avoid_elements).slice(0, 15)

  const layers: string[] = []
  const lines: string[] = []
  lines.push('【创作者人格 · 该用户的长期创作身份（自然贴合，禁止在正文中提及这些设定本身）】')
  if (personality) {
    lines.push(`创作者定位：${personality}`)
    layers.push('创作者人格定位')
  }
  if (summary) {
    lines.push(`对该创作者的理解：${summary}`)
    layers.push('AI 对你的创作理解')
  }
  if (topics.length) {
    lines.push(
      `持续关注的母题：${topics.join('、')}（当本次主题与这些母题相关时优先深挖；主题不同则以本次主题为准，不得强行套用）`
    )
    layers.push('偏好题材')
  }
  if (favorites.length) {
    lines.push(`偏好的表达元素（在合适处自然运用，不要堆砌）：${favorites.join('、')}`)
    layers.push('喜欢的表达元素')
  }
  if (avoid.length) {
    lines.push(`绝对避免的元素（硬禁忌，任何情况下都不要出现）：${avoid.join('、')}`)
    layers.push('排斥元素硬禁忌')
  }

  // 六个数据点全空 → 不注入
  if (!personality && !summary && !topics.length && !favorites.length && !avoid.length) {
    return { text: '', avoid: [], layers: [], traits: [] }
  }
  return { text: `\n\n${lines.join('\n')}`, avoid, layers, traits: [] }
}
