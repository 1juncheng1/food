// ============================================================
// CreatorDeclaration —— 用户主动声明的创作偏好（访谈结果）
//
// 与 CreatorReport（AI 被动推断）互补：
//   - CreatorDeclaration = 用户主动说的（权威边界，AI 不覆盖）
//   - CreatorReport       = AI 从作品素材学习的（被动推断）
// 两者都注入 prompt，但 declaration 优先级更高——用户说的 > AI 推断的
//
// 数据来源：首次访谈（阶段 3-4 实现）+ 设置页手动修改
// 持续学习：阶段 5 实现，行为信号修正 declaration
//
// 设计原则：
//   1. declaration 不覆盖主题：只影响"怎么写"，不影响"写什么"
//   2. declaration 是软约束：生成时可由主题规律适当调整
//   3. avoid_preference 是硬约束：等同 avoid_elements，生成时必须遵守
//   4. 空 declaration（未访谈）不注入，零污染生成
//   5. 本模块为纯函数，不读库不调 LLM，可复用
// ============================================================

// ── 1. 核心类型：用户声明 ────────────────────────────────────

/**
 * 用户主动声明的创作偏好（访谈结果）。
 * 每个字段对应访谈的一类问题，缺省为 undefined（未回答）。
 */
export interface CreatorDeclaration {
  // ── 6 类访谈维度 ──

  /** 创作目的：流量 / 品牌 / 转化 / 分享 */
  creator_goal?: string
  /** 表达方式：快速吸引 / 慢慢铺垫 / 深入分析 / 情绪冲击 */
  expression_profile?: string
  /** 思考方式：数据驱动 / 故事化 / 对比分析 / 案例支撑 */
  thinking_profile?: string
  /** 叙事偏好：故事化 / 分析式 / 对话式 / 散文式 */
  narrative_preference?: string
  /** 情绪倾向：紧张 / 温情 / 冷峻 / 热血 */
  emotional_preference?: string
  /** 判断好作品的标准：让人感动 / 让人思考 / 让人行动 / 让人学到 */
  quality_standard?: string
  /** 排斥内容（硬约束，等同 avoid_elements）：空洞鸡汤 / 流水账 / 夸张标题 / 无依据观点 */
  avoid_preference?: string
  /** 创作场景：短视频 / 文章 / 商业方案 / 知识分享 / 其他 */
  creation_scenario?: string

  // ── 元数据 ──

  /** 访谈完成时间（ISO 字符串） */
  interviewedAt?: string
  /** 访谈版本（未来问题集调整时 +1，便于触发重新访谈） */
  interviewVersion?: number
  /** 访谈来源：onboarding（首次访谈）/ settings（设置页修改）/ ai_update（AI 修正） */
  source?: 'onboarding' | 'settings' | 'ai_update'
}

// ── 2. 维度元数据（问题库用，阶段 3 会扩展）─────────────────

export type DeclarationDimension =
  | 'creator_goal'
  | 'expression_profile'
  | 'thinking_profile'
  | 'narrative_preference'
  | 'emotional_preference'
  | 'quality_standard'
  | 'avoid_preference'
  | 'creation_scenario'

/** 各维度的中文标签和用途说明（UI 展示和 prompt 注入共用） */
export const DECLARATION_DIMENSION_META: Array<{
  key: DeclarationDimension
  label: string
  /** 对生成的影响（prompt 注入时说明"这个维度影响什么"） */
  impact: string
  /** 是否硬约束（avoid_preference 是硬约束，其余是软约束） */
  hard?: boolean
}> = [
  {
    key: 'creator_goal',
    label: '创作目的',
    impact: '影响生成目标和内容方向',
  },
  {
    key: 'expression_profile',
    label: '表达方式',
    impact: '影响文章结构和节奏',
  },
  {
    key: 'thinking_profile',
    label: '思考方式',
    impact: '影响论证逻辑和素材选择',
  },
  {
    key: 'narrative_preference',
    label: '叙事偏好',
    impact: '影响叙事视角和推进方式',
  },
  {
    key: 'emotional_preference',
    label: '情绪倾向',
    impact: '影响情绪基调和氛围',
  },
  {
    key: 'quality_standard',
    label: '好作品标准',
    impact: '影响内容价值取向',
  },
  {
    key: 'avoid_preference',
    label: '排斥内容',
    impact: '硬约束：生成时必须避免',
    hard: true,
  },
  {
    key: 'creation_scenario',
    label: '创作场景',
    impact: '影响输出形式和适配平台',
  },
]

// ── 3. normalize 纯函数（服务端用，兜底清洗）──────────────

function s(v: unknown, max: number): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''
}

/**
 * 兜底清洗 CreatorDeclaration（从 style_profiles.creator_declaration jsonb 还原）。
 * 兼容 snake_case（后端 jsonb）和 camelCase（前端）。
 * 返回清洗后的 declaration；空对象返回空 declaration（不注入）。
 */
export function normalizeCreatorDeclaration(raw: unknown): CreatorDeclaration {
  const empty: CreatorDeclaration = {}
  if (typeof raw !== 'object' || raw === null) return empty
  const o = raw as Record<string, unknown>

  const result: CreatorDeclaration = {}

  // 8 个维度字段，每个限 200 字（用户选择项 + 自定义文本）
  const dimFields: Array<[keyof CreatorDeclaration, string]> = [
    ['creator_goal', 'creator_goal'],
    ['expression_profile', 'expression_profile'],
    ['thinking_profile', 'thinking_profile'],
    ['narrative_preference', 'narrative_preference'],
    ['emotional_preference', 'emotional_preference'],
    ['quality_standard', 'quality_standard'],
    ['avoid_preference', 'avoid_preference'],
    ['creation_scenario', 'creation_scenario'],
  ]

  for (const [camelKey, snakeKey] of dimFields) {
    const val = s(o[camelKey] ?? o[snakeKey], 200)
    if (val) {
      ;(result as Record<string, unknown>)[camelKey] = val
    }
  }

  // 元数据
  const interviewedAt = s(o.interviewedAt ?? o.interviewed_at, 50)
  if (interviewedAt) result.interviewedAt = interviewedAt

  const version = Number(o.interviewVersion ?? o.interview_version)
  if (Number.isFinite(version) && version > 0) {
    result.interviewVersion = version
  }

  const sourceRaw = s(o.source, 20)
  if (
    sourceRaw === 'onboarding' ||
    sourceRaw === 'settings' ||
    sourceRaw === 'ai_update'
  ) {
    result.source = sourceRaw
  }

  return result
}

// ── 4. 判定函数 ─────────────────────────────────────────────

/**
 * 判断 declaration 是否为空（未访谈）。
 * 8 个维度字段全部缺失时返回 true。
 */
export function isDeclarationEmpty(d: CreatorDeclaration): boolean {
  return (
    !d.creator_goal &&
    !d.expression_profile &&
    !d.thinking_profile &&
    !d.narrative_preference &&
    !d.emotional_preference &&
    !d.quality_standard &&
    !d.avoid_preference &&
    !d.creation_scenario
  )
}

/**
 * 判断 declaration 是否已完成访谈（至少回答了 6 个维度）。
 * 用于决定是否触发首次访谈。
 */
export function isDeclarationComplete(d: CreatorDeclaration): boolean {
  let answered = 0
  if (d.creator_goal) answered++
  if (d.expression_profile) answered++
  if (d.thinking_profile) answered++
  if (d.narrative_preference) answered++
  if (d.emotional_preference) answered++
  if (d.quality_standard) answered++
  if (d.avoid_preference) answered++
  if (d.creation_scenario) answered++
  return answered >= 6
}

// ── 5. prompt 注入函数（生成时调用）─────────────────────────

/**
 * 把 CreatorDeclaration 格式化为注入 LLM 的文本块。
 * 与 formatCreatorReportForPrompt 并列，注入生成 user prompt。
 *
 * 注入原则：
 *   1. 用户声明作为"软约束"（avoid_preference 除外，它是硬约束）
 *   2. 声明优先级高于 AI 推断的 CreatorReport
 *   3. 声明不覆盖本次主题，只影响"怎么写"
 *   4. 空声明返回空串，零污染
 */
export function formatDeclarationForPrompt(d: CreatorDeclaration): string {
  if (isDeclarationEmpty(d)) return ''

  const lines: string[] = []
  lines.push('【创作者主动声明 · 该用户对自己创作偏好的明确表达（自然贴合，禁止在正文中提及这些设定本身）】')

  // 6 类软约束维度（按 impact 顺序注入）
  const softDims: Array<{
    key: keyof CreatorDeclaration
    label: string
    impact: string
  }> = [
    { key: 'creator_goal', label: '创作目的', impact: '影响内容价值取向' },
    { key: 'expression_profile', label: '表达方式', impact: '影响文章节奏' },
    { key: 'thinking_profile', label: '思考方式', impact: '影响论证逻辑' },
    { key: 'narrative_preference', label: '叙事偏好', impact: '影响叙事推进' },
    { key: 'emotional_preference', label: '情绪倾向', impact: '影响情绪基调' },
    { key: 'quality_standard', label: '好作品标准', impact: '影响内容深度' },
    { key: 'creation_scenario', label: '创作场景', impact: '影响输出形式' },
  ]

  for (const dim of softDims) {
    const val = d[dim.key]
    if (val) {
      lines.push(`${dim.label}：${val}（${dim.impact}）`)
    }
  }

  // avoid_preference 是硬约束，单独强调
  if (d.avoid_preference) {
    lines.push(
      `绝对避免的内容（硬禁忌，任何情况下都不要出现）：${d.avoid_preference}`
    )
  }

  // 优先级声明（让 LLM 知道声明 > AI 推断）
  lines.push(
    '── 注意：以上声明是该用户主动表达的创作偏好，优先级高于 AI 从历史推断的风格画像；',
    '但本次主题和创作要求是最高优先级，声明只影响"怎么写"不影响"写什么"。──'
  )

  return `\n\n${lines.join('\n')}`
}

// ── 6. 与 CreatorReport 的融合函数 ──────────────────────────

/**
 * 提取 declaration 中实际生效的维度标签（供 UI 展示"本次参考了哪些声明"）。
 * 与 CreatorReport 的 AppliedTrait 并列，前端可合并展示。
 */
export interface DeclarationTrait {
  /** 维度名（中文） */
  dimension: string
  /** 用户声明的值 */
  label: string
  /** 是否硬约束 */
  hard?: boolean
}

export function extractDeclarationTraits(
  d: CreatorDeclaration
): DeclarationTrait[] {
  if (isDeclarationEmpty(d)) return []
  const traits: DeclarationTrait[] = []

  const mapping: Array<{
    key: keyof CreatorDeclaration
    dimension: string
    hard?: boolean
  }> = [
    { key: 'creator_goal', dimension: '创作目的' },
    { key: 'expression_profile', dimension: '表达方式' },
    { key: 'thinking_profile', dimension: '思考方式' },
    { key: 'narrative_preference', dimension: '叙事偏好' },
    { key: 'emotional_preference', dimension: '情绪倾向' },
    { key: 'quality_standard', dimension: '好作品标准' },
    { key: 'creation_scenario', dimension: '创作场景' },
    { key: 'avoid_preference', dimension: '排斥内容', hard: true },
  ]

  for (const m of mapping) {
    const val = d[m.key]
    if (typeof val === 'string' && val.trim()) {
      traits.push({ dimension: m.dimension, label: val.trim(), hard: m.hard })
    }
  }
  return traits
}
