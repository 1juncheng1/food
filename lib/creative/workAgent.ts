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

// ── 7. 共创会话（对应 setup.sql 第 18 节两张表）────────────

/** 三阶段状态机：clarify → propose → apply → done */
export type AgentPhase = 'clarify' | 'propose' | 'apply' | 'done'

/** 会话状态：进行中 / 已落地新版本 / 用户放弃 */
export type AgentSessionStatus = 'active' | 'applied' | 'abandoned'

/**
 * 交互模式（Work Agent 输出模式路由的产物）。
 *
 * 不是所有输入都是修改指令：
 *   companion 用户迷茫/受挫 → 先陪伴分析，不急着改
 *   discuss  用户在征询判断 → 先回答"你怎么看"，不给方案
 *   suggest  默认 → 走"澄清 → 方案 → 补丁"三步
 *   direct   用户明示别问了 → 跳过讨论直达修改建议
 */
export type InteractionMode = 'companion' | 'discuss' | 'suggest' | 'direct'

/**
 * 修改守门提示（AI 认为这个改法会伤害作品时的提醒）。
 *
 * 设计边界：**只提示不阻拦**。它是"我不同意"而不是"我不干"——
 * 用户看完坚持要改，AI 照改。字段必须给出替代方案，
 * 否则就是把"那你说怎么办"这个问题丢回给用户。
 */
export interface AgentAdvisory {
  /** 命中的风险规则 id（统计哪类提醒最常出现 / 最常被无视） */
  ruleId: string
  /** 这条改法的具体危害 */
  concern: string
  /** 为什么有害（讲清机制，让用户能自己判断） */
  why: string
  /** 替代改法（可执行） */
  better: string
}

/** 消息类型：既是展示分发的依据，也是后续统计共创行为的分类维度 */
export type AgentMessageKind =
  | 'intent_clarify' // AI 给出意图候选，等待用户选择
  | 'dialogue' // 讨论/陪伴模式的结构化回应（分析问题，不给候选）
  | 'proposal' // AI 给出多个修改方案，等待用户选择
  | 'patch_preview' // AI 给出段落补丁预览，等待用户接受/拒绝
  | 'confirm' // 用户已做决策的结果回执
  | 'system_notice' // 降级/错误提示（非对话内容，但必须可见）

/** 会话元信息指针（不存正文，避免与 generation_history 双写） */
export interface AgentSessionMeta {
  /** 用户在阶段1选中的意图候选 index */
  chosenIntentIndex?: number | null
  /** 用户在阶段2选中的方案 index */
  chosenPlanIndex?: number | null
  /** 累计用户发言轮次 */
  turnCount?: number
  /** 最近降级原因（可见即可诊断） */
  lastError?: string | null
  /**
   * 最近一轮被判定为哪种交互模式。
   * 记在会话上而不是只回传给前端：要能回答"这个用户更多是在讨论还是在改稿"，
   * 这是判断共创质量（AI 有没有逼着用户做选择）的关键统计口径。
   */
  lastMode?: InteractionMode | null
}

/** Work Agent 会话（work_agent_sessions 表一行） */
export interface WorkAgentSession {
  id: string
  userId: string
  projectId: string | null
  /** 发起对话时的基底版本行 id（generation_history.id） */
  baseVersionId: string | null
  status: AgentSessionStatus
  phase: AgentPhase
  meta: AgentSessionMeta
  createdAt: string
  updatedAt: string
}

/** Work Agent 消息（work_agent_messages 表一行） */
export interface WorkAgentMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  kind: AgentMessageKind
  /** 面向用户展示的文案（Markdown 轻量文本） */
  content: string
  /** 结构化载荷：IntentClarification / RevisionProposal / patches[] / FeedbackAnalysis */
  payload: unknown
  /** 用户在候选中选择的序号（null=未选择或自由输入）—— 数据飞轮核心字段 */
  selectedIndex: number | null
  createdAt: string
}

// ── 8. 阶段 1：意图澄清 ──────────────────────────────────

/**
 * 意图候选：用户一句模糊反馈（"感觉太平了"）背后的可能含义。
 * IntentOption.evidence 字段记录 AI 是基于哪类上下文推断出该候选的
 * （诊断 / 画像 / 素材），让"AI 为什么这么理解"可解释，而不是黑箱猜测。
 */
export interface IntentOption {
  /** 候选标识（如 'conflict'；同批候选内唯一即可） */
  id: string
  /** 候选标题（≤12 字，直接作为按钮文案） */
  label: string
  /** 一句话解释这个含义具体指什么 */
  description: string
  /** 指向 6 类优化方向之一 */
  intentType: NextActionKey
  /** AI 推断该候选的上下文依据（可展示为"我看出来是因为…"） */
  evidence?: string
}

/** 阶段 1 输出：一次澄清轮次的完整载荷 */
export interface IntentClarification {
  /** AI 对用户反馈的整体理解（一句话） */
  understanding: string
  /** 结合上下文发现的当前作品问题（≤4 条，直接展示给用户，作为"AI 看出了什么"） */
  observedIssues: string[]
  /** 候选含义（2-4 个） */
  options: IntentOption[]
  /** AI 推荐的候选 index（不确定时为 null） */
  recommendedIndex: number | null
}

// ── 9. 阶段 2：修改方案 ──────────────────────────────────

/** 修改策略：patch=段落级局部修改（默认，保护结构）/ rewrite=必须全文重写 */
export type RevisionStrategy = 'patch' | 'rewrite'

/**
 * 修改方案：给用户看的"这次改哪里、改了会怎样、有什么代价"。
 * 与全文重写的关键区别是 preserveItems：明确承诺"不动什么"。
 * 没有这个承诺，"局部修改"就无法被用户验证。
 */
export interface RevisionPlan {
  id: string
  /** 方案名（≤12 字，作为按钮文案，如"重构开头"） */
  title: string
  /** 方案具体做法（≤100 字） */
  description: string
  /** 修改的影响/收益（对用户可见的价值承诺） */
  expectedImpact: string
  /** 修改区域（从 IMPACT_SCOPE_VALUES 中取） */
  modificationArea: string[]
  /** 该方案承诺保持不变的内容（硬约束，注入 LLM） */
  preserveItems: string[]
  /** 风险提示（如"会改变原开头叙事视角"） */
  risk: string
  /** patch=局部 / rewrite=全文（仅当用户诉求本质需要重写时给出） */
  strategy: RevisionStrategy
}

/** 阶段 2 输出：一组可选方案 */
export interface RevisionProposal {
  /** 基于选中意图的一句话总结（"已确认方向：增强开头冲突"） */
  summary: string
  /** 2-3 个方案 */
  plans: RevisionPlan[]
  /** 建议方案 index */
  recommendedIndex: number | null
}

// ── 10. 阶段 3：补丁预览 ─────────────────────────────────

/** 补丁预览载荷：明确告知"即将改哪几段 / 保持什么不变" */
export interface PatchPreview {
  /** 本次修改依据的方案（可能为空，降级走 custom 意图时） */
  planId: string | null
  /** 即将改动的段落序号列表 */
  targetSegments: number[]
  /** 保持不变的承诺清单 */
  preserveItems: string[]
  /** AI 对本次修改的一句话说明 */
  summary: string
}

// ── 11. 外部知识源接口（预留）─────────────────────────────

/**
 * 外部知识源能力接口。本期只定义契约，不接任何外部依赖：
 * 实现由各源自行适配（新闻 / 知乎 / B站 / 抖音 / 网页搜索），
 * 失败必须降级为空数组而非抛错——AI 缺素材可以继续工作，崩溃则整个流程中断。
 */
export interface WorkAgentKnowledgeSource {
  /** 源标识（如 'news' / 'zhihu' / 'bilibili'） */
  id: string
  label: string
  /** 是否启用（未配置密钥的源恒定返回空，不报错） */
  enabled: boolean
  /**
   * 检索外部知识。返回结构化片段（≤ MAX_EXTERNAL_ITEMS 条）。
   * 契约：内部任何异常都必须吞掉并返回空数组。
   */
  search(query: string, opts: { limit?: number }): Promise<ExternalKnowledgeItem[]>
}

export interface ExternalKnowledgeItem {
  /** 来源标题 */
  title: string
  /** 摘要原文（注入 prompt 用，调用前已截断） */
  snippet: string
  /** 来源标注（展示与溯源用，如"知乎 · 2026-08"） */
  source: string
  /** 来源 id（溯源与去重） */
  sourceId?: string
}

/** 注入 prompt 的外部知识条数上限（放防止外部长文挤占 token 预算） */
export const MAX_EXTERNAL_ITEMS = 3

// ── 12. Work Agent 上下文包 ──────────────────────────────

/**
 * Work Agent 上下文：三个阶段（澄清 / 提案 / 补丁）的 LLM 调用统一携带。
 *
 * 为什么必须显式这些块——AI 不是普通聊天机器人：
 *   - work      → 知道"我们在讨论哪篇文章"
 *   - diagnosis → 知道"这篇文章当前什么问题"
 *   - goal      → 知道"用户最初想写什么"（防止迭代跑偏）
 *   - creator   → 知道"这是谁的文风"（防止改成统一 AI 味）
 *   - editing   → 知道"用户历史认可/拒绝什么"
 *   - materials → 知道"用户自己有什么素材"（优先于 AI 编造案例）
 *   - external  → 预留外部事实补充
 *
 * 所有块到达这里时已是「裁剪完成的纯文本」，由 workAgentContext.ts 统一装配，
 * LLM 层只负责消费，不再各自拼 prompt（避免同一份画像在多处口径漂移）。
 */
/** 一次历史修改的轨迹（本项目上一版改了什么、依据哪句反馈） */
export interface RevisionTrace {
  versionNumber: number
  /** 迭代方向（improve_direction） */
  direction: string | null
  /** AI 说这一版改了什么（improve_note） */
  note: string | null
  /** 该版依据的用户反馈原话（user_feedback） */
  feedback: string | null
}

export interface WorkAgentContext {
  work: {
    title: string
    topic: string
    versionNumber: number
    versionId: string
    createdAt: string
    /** 截断后的正文（≤ WORK_CONTENT_LIMIT） */
    content: string
    /** 总段数（from splitParagraphs） */
    segmentCount: number
  }
  /** 当前版本的 AI 五维诊断（可能为 null：未诊断或游客作品） */
  diagnosis: CreativeDiagnosis | null
  /** 用户原始创作目标（blueprint.problem_understanding 等） */
  goal: string
  /** 目标读者（blueprint.target_audience）——判断"该让谁读懂"的唯一依据 */
  audience: string
  /** 创作者自己确认过的知识单元（Creator Knowledge 注入块） */
  knowledge: string
  /** 本项目历史修改轨迹（按版本号倒序，≤ CONTEXT_REVISION_LIMIT 条） */
  revisionHistory: RevisionTrace[]
  /** Creator Profile 人格块（formatCreatorModel 输出） */
  creator: string
  /** 编辑偏好块（formatEditingProfileForPrompt 输出，样本不足时为空串） */
  editing: string
  /** 用户个人素材库召回结果（每条已截断） */
  materials: Array<{ title: string; content: string; reason: string }>
  /** 外部知识（本期为 stub，通常为空） */
  external: ExternalKnowledgeItem[]
  /** 上下文降级说明（如 embedding 失败），需对用户可见 */
  degraded: string[]
}

// ── 13. DB 行 → 领域对象（session 路由与 chat 路由共用）────

/**
 * work_agent_sessions 行映射。
 * 为什么容忍任意 Record：老库可能缺列（未跑第 18 节），
 * 映射层必须比 DAO 更宽容——缺列降级为空值，而不是把 500 抛给用户。
 */
export function mapSessionRow(row: Record<string, unknown>): WorkAgentSession {
  const rawMeta = row.meta
  return {
    id: String(row.id ?? ''),
    userId: String(row.user_id ?? ''),
    projectId: typeof row.project_id === 'string' ? row.project_id : null,
    baseVersionId: typeof row.base_version_id === 'string' ? row.base_version_id : null,
    status: (row.status === 'applied' || row.status === 'abandoned' ? row.status : 'active') as AgentSessionStatus,
    phase: (['clarify', 'propose', 'apply', 'done'].includes(String(row.phase))
      ? String(row.phase)
      : 'clarify') as AgentPhase,
    meta: typeof rawMeta === 'object' && rawMeta !== null ? (rawMeta as AgentSessionMeta) : {},
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  }
}

const MESSAGE_KINDS: AgentMessageKind[] = [
  'intent_clarify',
  'dialogue',
  'proposal',
  'patch_preview',
  'confirm',
  'system_notice',
]

/** work_agent_messages 行映射（同上，缺列降级） */
export function mapMessageRow(row: Record<string, unknown>): WorkAgentMessage {
  const rawKind = String(row.kind ?? '')
  const numIdx = Number(row.selected_index)
  return {
    id: String(row.id ?? ''),
    sessionId: String(row.session_id ?? ''),
    role: row.role === 'user' ? 'user' : 'assistant',
    kind: (MESSAGE_KINDS.includes(rawKind as AgentMessageKind)
      ? rawKind
      : 'intent_clarify') as AgentMessageKind,
    content: typeof row.content === 'string' ? row.content : '',
    payload: row.payload ?? null,
    selectedIndex: Number.isInteger(numIdx) ? numIdx : null,
    createdAt: String(row.created_at ?? ''),
  }
}

// ── 14. 阶段产出的兜底清洗（服务端用）─────────────────────

function s2(v: unknown, max: number): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''
}

function strArr(v: unknown, max: number, len: number): string[] {
  return Array.isArray(v)
    ? (v as unknown[]).map((x) => s2(x, len)).filter(Boolean).slice(0, max)
    : []
}

/**
 * 清洗 IntentClarification LLM 输出。
 * 有效判定：必须有 understanding，且至少有 2 个候选（<2 就失去"多含义供选"的意义）。
 */
export function normalizeIntentClarification(raw: unknown): IntentClarification | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const understanding = s2(o.understanding, 200)
  if (!understanding) return null

  const rawOpts = Array.isArray(o.options) ? o.options : []
  const options: IntentOption[] = []
  for (const item of rawOpts) {
    if (typeof item !== 'object' || item === null) continue
    const c = item as Record<string, unknown>
    const label = s2(c.label, 20)
    const description = s2(c.description, 120)
    const intentType = toNextAction(c.intentType ?? c.intent_type)
    if (!label || !description || !intentType) continue
    options.push({
      id: s2(c.id, 40) || `opt-${options.length + 1}`,
      label,
      description,
      intentType,
      evidence: s2(c.evidence, 120) || undefined,
    })
    if (options.length >= 4) break
  }
  if (options.length < 2) return null

  const recIdx = Number(o.recommendedIndex ?? o.recommended_index)
  return {
    understanding,
    observedIssues: strArr(o.observedIssues ?? o.observed_issues, 4, 100),
    options,
    recommendedIndex:
      Number.isInteger(recIdx) && recIdx >= 0 && recIdx < options.length ? recIdx : null,
  }
}

/**
 * 清洗 RevisionProposal LLM 输出。
 * 有效判定：至少 2 个方案且每个方案必备 title/description/strategy。
 * preserveItems 为空时兜底——"什么都不承诺不动"的方案会让局部修改失去可信度。
 */
/**
 * 单个方案的字段级清洗。
 * preserveItems 为空时兜底为「核心观点与整体结构」：
 *   没有"不动什么"承诺的方案，等于允许 AI 任意发挥，局部修改就名存实亡。
 */
function parsePlanItem(raw: unknown, index: number): RevisionPlan | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  const title = s2(p.title, 20)
  const description = s2(p.description, 200)
  if (!title || !description) return null
  const preserve = strArr(p.preserveItems ?? p.preserve_items, 4, 30)
  return {
    id: s2(p.id, 40) || `plan-${index + 1}`,
    title,
    description,
    expectedImpact: s2(p.expectedImpact ?? p.expected_impact, 120),
    modificationArea: strArr(p.modificationArea ?? p.modification_area, 3, 10).filter((v) =>
      (IMPACT_SCOPE_VALUES as readonly string[]).includes(v)
    ),
    preserveItems: preserve.length > 0 ? preserve : ['核心观点与整体结构'],
    risk: s2(p.risk, 100),
    strategy: p.strategy === 'rewrite' ? 'rewrite' : 'patch',
  }
}

export function normalizeRevisionProposal(raw: unknown): RevisionProposal | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const rawPlans = Array.isArray(o.plans) ? o.plans : []
  const plans: RevisionPlan[] = []
  for (const item of rawPlans) {
    const plan = parsePlanItem(item, plans.length)
    if (plan) plans.push(plan)
    if (plans.length >= 3) break
  }
  if (plans.length < 2) return null

  const recIdx = Number(o.recommendedIndex ?? o.recommended_index)
  return {
    summary: s2(o.summary, 200),
    plans,
    recommendedIndex:
      Number.isInteger(recIdx) && recIdx >= 0 && recIdx < plans.length ? recIdx : null,
  }
}

/**
 * 清洗单个 RevisionPlan（decide 落版时使用）。
 * 客户端回传的方案不可信（可伪造"保持全文不变"骗过 LLM 硬约束），必须服务端重走一遍。
 * 注意不能复用 normalizeRevisionProposal——那里要求至少 2 个方案才判定有效。
 */
export function normalizeRevisionPlan(raw: unknown): RevisionPlan | null {
  return parsePlanItem(raw, 0)
}

/** 清洗补丁预览载荷（ stage 3 展示"即将改哪、保持什么"） */
export function normalizePatchPreview(raw: unknown): PatchPreview | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const summary = s2(o.summary, 200)
  if (!summary) return null
  // 先取值再断言：直接在 ?? 右侧写 as 会被解析成一个整体表达式导致类型退化
  const rawSegs = (o.targetSegments ?? o.target_segments) as unknown
  const segs = Array.isArray(rawSegs)
    ? (rawSegs as unknown[])
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n >= 1)
        .slice(0, 5)
    : []
  return {
    planId: s2(o.planId ?? o.plan_id, 40) || null,
    targetSegments: segs,
    preserveItems: strArr(o.preserveItems ?? o.preserve_items, 4, 30),
    summary,
  }
}

// ── 15. 守门提示与讨论型回应 ─────────────────────────────

/**
 * 清洗守门提示（存在 assistant 消息 payload.advisory 里，刷新后仍需可见）。
 * 四字段缺一即视为无效——缺 better 的提示只会给用户添堵。
 */
export function normalizeAdvisory(raw: unknown): AgentAdvisory | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const ruleId = s2(o.ruleId ?? o.rule_id, 40)
  const concern = s2(o.concern, 120)
  const why = s2(o.why, 200)
  const better = s2(o.better, 200)
  if (!ruleId || !concern || !why || !better) return null
  return { ruleId, concern, why, better }
}

/**
 * 讨论/陪伴模式的结构化回应。
 * 与 IntentClarification 的区别：这里**不给候选**（不给"请选择方向"的按钮），
 * 只给理解、原因、建议方向和一个待确认的问题——用户还没决定要改。
 */
export interface AgentDialogue {
  /** 我的理解（一句话复述用户的处境） */
  understanding: string
  /** 可能的原因（2-4 条，必须基于上下文中真实存在的证据） */
  causes: string[]
  /** 建议方向（2-3 条，可执行） */
  directions: string[]
  /** 一个待用户确认的开放问题（把"下一步怎么走"的决定权交回去） */
  question: string
}

/**
 * 清洗 AgentDialogue LLM 输出。
 * 有效判定：understanding 与 question 必填——没有问题的讨论等于自说自话，
 * 而 Work Agent 的核心职责是"会提问"。
 */
export function normalizeAgentDialogue(raw: unknown): AgentDialogue | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const understanding = s2(o.understanding, 300)
  const question = s2(o.question, 200)
  if (!understanding || !question) return null
  return {
    understanding,
    causes: strArr(o.causes, 4, 120),
    directions: strArr(o.directions, 3, 120),
    question,
  }
}