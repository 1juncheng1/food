// ============================================================
// Work Agent（作品智能体）—— 作品持续进化系统
//
// 让用户生成作品后可以继续与作品交流、反馈和持续优化。
// 形成 V1 → V2 → V3 的版本进化链。
//
// 设计原则：
//   1. 复用现有表结构：generation_feedback 扩 2 列，generation_history 扩 1 列
//   2. 复用现有 6 类优化方向（NextActionKey），不引入新枚举
//   3. Feedback Analyzer 输出可注入 FrozenPlan，让下一版生成时 AI 知道用户反馈
//   4. 本文件只定义类型和纯函数，不动 UI 和 API 逻辑
// ============================================================

import type { CreativeBlueprint } from './blueprint'
import type { CreativeDiagnosis, NextActionKey } from './diagnosis'
import type { FrozenPlan } from './plan'
import type { ClarificationAnswer } from './intentClarity'

// ── 1. 反馈类型扩展 ────────────────────────────────────────

/**
 * 反馈类型：在现有 4 种枚举基础上，新增 'optimize' 表示"基于自由文本的智能优化"。
 * - like/dislike/edit/regenerate：现有 4 种，保留不动
 * - optimize：用户输入自由反馈（如"开头不够吸引人"），AI 分析后触发新版本
 */
export type WorkFeedbackType =
  | 'like'
  | 'dislike'
  | 'edit'
  | 'regenerate'
  | 'optimize'

/**
 * 用户反馈记录（对应 generation_feedback 表一行）。
 * 扩展现有表结构：free_text + analysis_result 是新增字段。
 */
export interface WorkFeedback {
  id: string // generation_feedback.id (uuid)
  generationId: string // 关联的 generation_history.id (作品版本行 id)
  feedbackType: WorkFeedbackType
  // ── 现有字段 ──
  editedContent?: string | null // feedback_type='edit' 时用户修改后的全文
  direction?: NextActionKey | null // 用户选择的优化方向（6 类枚举之一）
  createdAt: string // 落库时间
  // ── Work Agent 新增字段 ──
  /** 用户自由输入的反馈原文（如"开头不够吸引人""不够震撼"） */
  freeText?: string | null
  /** Feedback Analyzer 的结构化输出（AI 分析后的优化蓝图） */
  analysisResult?: FeedbackAnalysis | null
}

// ── 2. Feedback Analyzer 输出 ──────────────────────────────

/** 影响范围合法枚举（6 段位，patch 定位与展示共用） */
export const IMPACT_SCOPE_VALUES = ['开头', '背景', '核心内容', '高潮', '结尾', '全篇'] as const

/**
 * AI 反馈分析结果：把用户的自由文本反馈翻译为结构化优化蓝图。
 *
 * 例：
 *   用户输入"不够震撼"
 *   → intent_type: 'emotion'（情绪增强）
 *   → modification_targets: ['开头冲突', '情绪曲线', '结尾升华']
 *   → optimization_blueprint: '增强开头冲突，提高情绪曲线峰值，结尾增加价值升华'
 */
export interface FeedbackAnalysis {
  /** 反馈意图分类：指向 6 类优化方向之一 */
  intentType: NextActionKey
  /** AI 从反馈中提取的具体修改点（2-5 个） */
  modificationTargets: string[]
  /** 可直接注入下一版生成的优化蓝图片段（自然语言，100-300 字） */
  optimizationBlueprint: string
  /** AI 对用户反馈的一句话理解（展示给用户确认） */
  userIntentSummary: string
  /** AI 判定的影响范围（从 开头/背景/核心内容/高潮/结尾/全篇 中取 1-3 个） */
  impactScope?: string[]
  /** 本次修改必须保持不变的内容（2-4 项，如"故事主题""人物关系"） */
  preserveItems?: string[]
  /** 分析时间戳（落库时挂） */
  analyzedAt?: string
}

// ── 3. Work Agent 主结构 ───────────────────────────────────

/**
 * 作品版本：对应 generation_history 表一行（project_id 相同的多个版本）。
 */
export interface WorkVersion {
  versionId: string // generation_history.id (pid::vN)
  versionNumber: number // 版本号 V1/V2/V3…
  content: string // 正文
  systemPrompt?: string // 系统提示词
  // ── 版本溯源 ──
  /** 该版本基于哪条用户反馈生成（V1 为 null） */
  userFeedback?: string | null
  /** AI 说"这一版改了什么"（现有 improve_note 字段） */
  improveNote?: string | null
  /** 该版本的优化方向（现有 improve_direction 字段） */
  improveDirection?: NextActionKey | null
  /** 该版本依据的蓝图（现有 blueprint jsonb） */
  blueprint?: FrozenPlan | null
  /** AI 诊断报告（现有 analysis jsonb） */
  analysis?: CreativeDiagnosis | null
  createdAt: string // 落库时间
}

/**
 * Work Agent：一个作品项目的完整进化状态。
 * 不落库为独立表——从 creative_projects + generation_history + generation_feedback 聚合而来。
 */
export interface WorkAgent {
  // ── 项目主体（creative_projects 表）──
  workId: string // creative_projects.id
  userId: string
  title: string // 作品名（通常取主题）
  topic: string // 原始输入主题
  status: 'active' | 'finalized' // active=迭代中 / finalized=已定稿
  currentVersion: number // 当前最新版本号
  createdAt: string
  updatedAt: string

  // ── 原始意图（V1 的 blueprint.problem_understanding）──
  originalGoal?: string // 用户真实目标（为什么需要它）
  originalBlueprint?: FrozenPlan // V1 的完整蓝图

  // ── 版本链（generation_history where project_id=X order by version_number）──
  versions: WorkVersion[]

  // ── 反馈历史（generation_feedback where generation_id IN versions[].versionId）──
  feedbackHistory: WorkFeedback[]

  // ── 当前优化方向（最新版本承接的反馈分析结果）──
  optimizationDirection?: FeedbackAnalysis | null
}

// ── 4. normalize 纯函数（服务端用，兜底清洗）──────────────

function s(v: unknown, max: number): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''
}

const VALID_NEXT_ACTIONS = new Set<string>([
  'hit',
  'style',
  'emotion',
  'depth',
  'video',
  'script',
  'custom',
])

function toNextAction(v: unknown): NextActionKey | null {
  const a = s(v, 20)
  return VALID_NEXT_ACTIONS.has(a) ? (a as NextActionKey) : null
}

/**
 * 兜底清洗 FeedbackAnalysis LLM 输出。
 * 无效返回 null：调用方降级为"不分析，直接把 freeText 注入下一版"。
 */
export function normalizeFeedbackAnalysis(raw: unknown): FeedbackAnalysis | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const intentType = toNextAction(o.intentType ?? o.intent_type)
  if (!intentType) return null

  const targetsRaw = o.modificationTargets ?? o.modification_targets
  const targets = Array.isArray(targetsRaw)
    ? (targetsRaw as unknown[])
        .map((t: unknown) => s(t, 50))
        .filter(Boolean)
    : []
  if (targets.length === 0) return null

  const blueprint = s(o.optimizationBlueprint ?? o.optimization_blueprint, 1000)
  const summary = s(o.userIntentSummary ?? o.user_intent_summary, 200)
  if (!blueprint || !summary) return null

  // 影响范围：只保留 6 段位枚举内的合法值（最多 3 个）
  const scopeRaw = o.impactScope ?? o.impact_scope
  const impactScope = Array.isArray(scopeRaw)
    ? (scopeRaw as unknown[])
        .map((v: unknown) => s(v, 10))
        .filter((v): v is string => (IMPACT_SCOPE_VALUES as readonly string[]).includes(v))
        .slice(0, 3)
    : []

  // 保持内容：最多 4 项；缺失时兜底为主题与结构（硬约束默认项）
  const preserveRaw = o.preserveItems ?? o.preserve_items
  const preserveItems = Array.isArray(preserveRaw)
    ? (preserveRaw as unknown[]).map((v: unknown) => s(v, 30)).filter(Boolean).slice(0, 4)
    : []
  if (preserveItems.length === 0) preserveItems.push('故事主题与整体结构')

  return {
    intentType,
    modificationTargets: targets.slice(0, 5),
    optimizationBlueprint: blueprint,
    userIntentSummary: summary,
    impactScope,
    preserveItems,
  }
}

/**
 * 兜底清洗 WorkFeedback（从 generation_feedback 行还原）。
 */
export function normalizeWorkFeedback(raw: unknown): WorkFeedback | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const id = s(o.id, 100)
  const generationId = s(o.generationId ?? o.generation_id, 200)
  const feedbackType = s(o.feedbackType ?? o.feedback_type, 20) as WorkFeedbackType
  if (!id || !generationId || !feedbackType) return null

  return {
    id,
    generationId,
    feedbackType,
    editedContent: s(o.editedContent ?? o.edited_content, 100000) || null,
    direction: toNextAction(o.direction),
    createdAt: s(o.createdAt ?? o.created_at, 50),
    freeText: s(o.freeText ?? o.free_text, 2000) || null,
    analysisResult: normalizeFeedbackAnalysis(o.analysisResult ?? o.analysis_result),
  }
}

// ── 5. prompt 注入函数（下一版生成时调用）─────────────────

/**
 * 把 FeedbackAnalysis 格式化为注入 LLM 的文本块。
 * 与 formatProblemForPrompt / formatBlueprintForPrompt 并列，注入下一版生成的 user prompt。
 *
 * 注入原则：用户反馈作为"修改指令"，优先级高于 AI 自主创作。
 */
export function formatFeedbackForPrompt(
  analysis: FeedbackAnalysis,
  freeText?: string | null
): string {
  const lines: string[] = [
    `【用户反馈优化指令】`,
    `用户反馈原文：${freeText || '（用户选择快捷方向，无自由文本）'}`,
    `AI 理解的意图：${analysis.userIntentSummary}`,
    `优化方向：${analysis.intentType}`,
    `具体修改点：`,
    ...analysis.modificationTargets.map((t, i) => `  ${i + 1}. ${t}`),
    `优化蓝图：${analysis.optimizationBlueprint}`,
  ]
  if (analysis.impactScope?.length) {
    lines.push(`影响范围：${analysis.impactScope.join('、')}`)
  }
  if (analysis.preserveItems?.length) {
    lines.push(
      `必须保持不变（硬约束）：${analysis.preserveItems.join('、')}——以下内容禁止改动。`
    )
  }
  lines.push(`── 注意：以上修改指令优先级高于自主创作，必须在下一版中体现这些修改。──`)
  return lines.join('\n')
}

// ── 6. localStorage 缓存键（前端用）────────────────────────

/**
 * Work Agent 会话级缓存键：存储当前作品项目的 WorkAgent 状态。
 * 用于 article 页刷新后快速恢复反馈历史和版本链。
 * 登录用户按 id 分桶（与 generated_works 一致）。
 */
export const WORK_AGENT_KEY = 'work_agent_'
