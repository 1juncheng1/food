// ============================================================
// KnowledgeItem —— 创作者知识库的结构化素材单元
//
// 设计原则：
//   1. knowledge 是 AI 理解后的结构化数据，不是原始文本
//   2. 6 维标签体系：Content / Thought / Emotion / Expression / Usage / Audience
//   3. knowledge 不影响现有 category 字段（category = 用户视角粗分类）
//   4. 老素材 knowledge = null 兼容，新素材必须走 AI 理解后才写
//   5. confidence < 0.6 时，KnowledgeItem 不参与生成检索
//   6. KnowledgeItem 不直接影响 CreatorProfile，走累积阈值软修正（阶段 5）
// ============================================================

// ── 1. 6 维标签体系 ───────────────────────────────────────

/**
 * 内容标签：这个内容讨论什么。
 * 示例：电影 / 科技 / 商业 / 历史 / 心理 / 社会 / 文化
 */
export type ContentTag =
  | '电影'
  | '科技'
  | '商业'
  | '历史'
  | '心理'
  | '社会'
  | '文化'
  | '科学'
  | '生活'
  | '教育'
  | '政治'
  | '艺术'
  | '体育'
  | '其他'

/**
 * 思想标签：内容背后的核心思想。
 * 示例：人性 / 成长 / 自由 / 权力 / 选择 / 孤独 / 创新 / 竞争 / 文明
 */
export type ThoughtTag =
  | '人性'
  | '成长'
  | '自由'
  | '权力'
  | '选择'
  | '孤独'
  | '创新'
  | '竞争'
  | '文明'
  | '正义'
  | '命运'
  | '信仰'
  | '矛盾'
  | '其他'

/**
 * 情绪标签：内容带来的情绪。
 * 示例：恐惧 / 震撼 / 悲伤 / 希望 / 愤怒 / 治愈 / 紧张
 */
export type EmotionTag =
  | '恐惧'
  | '震撼'
  | '悲伤'
  | '希望'
  | '愤怒'
  | '治愈'
  | '紧张'
  | '温情'
  | '冷峻'
  | '热血'
  | '平静'
  | '焦虑'
  | '其他'

/**
 * 表达方式标签：如何表达。
 * 示例：故事化 / 观点分析 / 案例拆解 / 第一人称 / 反转 / 悬念 / 深度分析
 */
export type ExpressionTag =
  | '故事化'
  | '观点分析'
  | '案例拆解'
  | '第一人称'
  | '反转'
  | '悬念'
  | '深度分析'
  | '对比'
  | '叙事'
  | '议论'
  | '其他'

/**
 * 创作用途标签：适合如何使用。
 * 示例：开头钩子 / 观点素材 / 案例素材 / 结尾升华 / 剧情素材 / 标题灵感
 */
export type UsageTag =
  | '开头钩子'
  | '观点素材'
  | '案例素材'
  | '结尾升华'
  | '剧情素材'
  | '标题灵感'
  | '结构参考'
  | '情绪铺垫'
  | '其他'

/**
 * 受众标签：适合什么人。
 * 示例：创业者 / 年轻用户 / 电影爱好者 / 专业人士
 */
export type AudienceTag =
  | '创业者'
  | '年轻用户'
  | '电影爱好者'
  | '专业人士'
  | '学生'
  | '家长'
  | '大众'
  | '深度阅读用户'
  | '其他'

// ── 2. 维度元数据（供 UI 展示和 prompt 注入）──────────────

export interface DimensionMeta<T extends string> {
  key: string
  label: string
  description: string
  values: readonly T[]
}

export const KNOWLEDGE_DIMENSIONS = {
  content: {
    key: 'content_tags',
    label: '内容',
    description: '这个内容讨论什么',
    values: [
      '电影', '科技', '商业', '历史', '心理', '社会', '文化',
      '科学', '生活', '教育', '政治', '艺术', '体育', '其他',
    ] as const,
  },
  thought: {
    key: 'thought_tags',
    label: '思想',
    description: '内容背后的核心思想',
    values: [
      '人性', '成长', '自由', '权力', '选择', '孤独', '创新',
      '竞争', '文明', '正义', '命运', '信仰', '矛盾', '其他',
    ] as const,
  },
  emotion: {
    key: 'emotion_tags',
    label: '情绪',
    description: '内容带来的情绪',
    values: [
      '恐惧', '震撼', '悲伤', '希望', '愤怒', '治愈', '紧张',
      '温情', '冷峻', '热血', '平静', '焦虑', '其他',
    ] as const,
  },
  expression: {
    key: 'expression_tags',
    label: '表达方式',
    description: '如何表达',
    values: [
      '故事化', '观点分析', '案例拆解', '第一人称', '反转',
      '悬念', '深度分析', '对比', '叙事', '议论', '其他',
    ] as const,
  },
  usage: {
    key: 'usage_tags',
    label: '创作用途',
    description: '适合如何使用',
    values: [
      '开头钩子', '观点素材', '案例素材', '结尾升华', '剧情素材',
      '标题灵感', '结构参考', '情绪铺垫', '其他',
    ] as const,
  },
  audience: {
    key: 'audience_tags',
    label: '受众',
    description: '适合什么人',
    values: [
      '创业者', '年轻用户', '电影爱好者', '专业人士', '学生',
      '家长', '大众', '深度阅读用户', '其他',
    ] as const,
  },
} as const

// ── 3. KnowledgeItem 类型 ─────────────────────────────────

/**
 * 创作者知识库单元。
 * 存 scripts.knowledge jsonb 列，与原始 content 并列。
 */
export interface KnowledgeItem {
  // AI 理解结果
  meaning: string // AI 理解该素材的意义（1-2 句话）
  context: string // 使用场景描述
  content_type: string // AI 判断素材用途（自由文本，不同于 scripts.category 枚举）

  // 多维标签
  content_tags: ContentTag[] // 内容标签（1-3 个）
  thought_tags: ThoughtTag[] // 思想标签（0-3 个）
  emotion_tags: EmotionTag[] // 情绪标签（0-3 个）
  expression_tags: ExpressionTag[] // 表达方式标签（1-3 个）
  usage_tags: UsageTag[] // 创作用途标签（1-3 个）
  audience_tags: AudienceTag[] // 受众标签（0-3 个）

  // 情绪与思想信息（比标签更细粒度）
  emotion_profile?: string // 情绪信息（如"紧张中带有反讽"）
  thought_profile?: string // 思想信息（如"对权力的反思"）

  // 创作用途详述
  creation_usage?: string // 创作用途详述（如"适合做悬疑类视频的开场钩子"）

  // 元数据
  confidence: number // AI 判断置信度 0-1（< 0.6 不参与检索）
  analyzed_at: string // AI 分析时间（ISO）
  ai_model?: string // 分析用的模型名
  clarification_asked?: boolean // 是否问过用户补充问题
}

// ── 4. 兜底清洗函数 ───────────────────────────────────────

function s(v: unknown, max: number): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''
}

function arr<T extends string>(
  v: unknown,
  allowed: readonly T[],
  maxLen: number
): T[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<T>()
  for (const item of v) {
    if (typeof item === 'string' && allowed.includes(item as T)) {
      seen.add(item as T)
      if (seen.size >= maxLen) break
    }
  }
  return Array.from(seen)
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  if (isNaN(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * 兜底清洗 LLM/DB 输出。
 * 无效返回 null：调用方降级为"不写 knowledge 字段，素材照常保存但无 AI 理解"。
 */
export function normalizeKnowledgeItem(raw: unknown): KnowledgeItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  // 兼容 snake_case 和 camelCase
  const meaning = s(o.meaning, 500)
  const context = s(o.context, 300)
  const content_type = s(o.content_type ?? o.contentType, 100)

  if (!meaning || !content_type) return null

  const content_tags = arr(o.content_tags ?? o.contentTags, KNOWLEDGE_DIMENSIONS.content.values, 3)
  const thought_tags = arr(o.thought_tags ?? o.thoughtTags, KNOWLEDGE_DIMENSIONS.thought.values, 3)
  const emotion_tags = arr(o.emotion_tags ?? o.emotionTags, KNOWLEDGE_DIMENSIONS.emotion.values, 3)
  const expression_tags = arr(o.expression_tags ?? o.expressionTags, KNOWLEDGE_DIMENSIONS.expression.values, 3)
  const usage_tags = arr(o.usage_tags ?? o.usageTags, KNOWLEDGE_DIMENSIONS.usage.values, 3)
  const audience_tags = arr(o.audience_tags ?? o.audienceTags, KNOWLEDGE_DIMENSIONS.audience.values, 3)

  // content_tags 和 usage_tags 是核心维度，缺失视为无效
  if (content_tags.length === 0 || usage_tags.length === 0) return null

  const confidence = num(o.confidence, 0, 1, 0.5)

  return {
    meaning,
    context,
    content_type,
    content_tags,
    thought_tags,
    emotion_tags,
    expression_tags,
    usage_tags,
    audience_tags,
    emotion_profile: s(o.emotion_profile ?? o.emotionProfile, 200) || undefined,
    thought_profile: s(o.thought_profile ?? o.thoughtProfile, 200) || undefined,
    creation_usage: s(o.creation_usage ?? o.creationUsage, 300) || undefined,
    confidence,
    analyzed_at: s(o.analyzed_at ?? o.analyzedAt, 40) || new Date().toISOString(),
    ai_model: s(o.ai_model ?? o.aiModel, 50) || undefined,
    clarification_asked: Boolean(o.clarification_asked ?? o.clarificationAsked),
  }
}

// ── 5. 工具函数 ───────────────────────────────────────────

/** 判断 knowledge 是否为空（null 或未分析） */
export function isKnowledgeEmpty(k: unknown): boolean {
  if (k === null || k === undefined) return true
  if (typeof k !== 'object') return true
  return Object.keys(k as object).length === 0
}

/** 判断 knowledge 是否可参与生成检索（confidence >= 0.6） */
export function isKnowledgeUsable(k: KnowledgeItem | null | undefined): boolean {
  if (!k) return false
  return k.confidence >= 0.6
}

/** 提取生效标签维度（供 UI 展示） */
export interface KnowledgeTrait {
  dimension: string
  label: string
  tags: string[]
}

export function extractKnowledgeTraits(k: KnowledgeItem): KnowledgeTrait[] {
  const traits: KnowledgeTrait[] = []
  if (k.content_tags.length > 0) {
    traits.push({ dimension: 'content', label: '内容', tags: k.content_tags })
  }
  if (k.thought_tags.length > 0) {
    traits.push({ dimension: 'thought', label: '思想', tags: k.thought_tags })
  }
  if (k.emotion_tags.length > 0) {
    traits.push({ dimension: 'emotion', label: '情绪', tags: k.emotion_tags })
  }
  if (k.expression_tags.length > 0) {
    traits.push({ dimension: 'expression', label: '表达方式', tags: k.expression_tags })
  }
  if (k.usage_tags.length > 0) {
    traits.push({ dimension: 'usage', label: '创作用途', tags: k.usage_tags })
  }
  if (k.audience_tags.length > 0) {
    traits.push({ dimension: 'audience', label: '受众', tags: k.audience_tags })
  }
  return traits
}

/** 格式化为注入生成 prompt 的文本块 */
export function formatKnowledgeForPrompt(
  items: KnowledgeItem[],
  opts?: { maxItems?: number; maxLength?: number }
): string {
  if (!items.length) return ''
  const maxItems = opts?.maxItems ?? 5
  const maxLength = opts?.maxLength ?? 800
  const selected = items.slice(0, maxItems)

  const lines: string[] = [
    '【创作者知识库·相关素材】',
    '以下素材来自用户积累的知识库，AI 已理解其意义和用途，请参考但不照抄：',
    '',
  ]

  let totalLen = lines.join('\n').length
  for (let i = 0; i < selected.length; i++) {
    const k = selected[i]
    const block = [
      `素材 ${i + 1}：`,
      `  意义：${k.meaning}`,
      `  用途：${k.content_type}`,
      k.creation_usage ? `  创作用途：${k.creation_usage}` : '',
      `  标签：${k.content_tags.join('、')}/${k.usage_tags.join('、')}${
        k.emotion_tags.length ? '/' + k.emotion_tags.join('、') : ''
      }`,
      k.thought_profile ? `  思想：${k.thought_profile}` : '',
    ].filter(Boolean).join('\n')

    if (totalLen + block.length > maxLength) break
    lines.push(block, '')
    totalLen += block.length + 1
  }

  return lines.join('\n').trim()
}
