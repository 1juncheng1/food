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

// ── 1.5 知识主张（Claims）—— 素材里的「事实 / 数据 / 观点 / 经历」 ──
//
// 存在意义：6 维标签回答的是「这条素材是什么类型」，而 claims 回答的是
// 「这条素材到底说了什么」。后者才是 Creator Knowledge System 的上游燃料：
// 知识单元由 claims 跨素材聚合而来，而不是由标签统计而来。
//
// 设计原则（严格区别于标签）：
//   1. 每条 claim 是一个命题（完整句子），不是枚举值
//   2. 必须记录来源与可信度 —— 无来源的主观断言与带出处的数据不能同等对待
//   3. 必须记录适用场景 —— 这是后续「相关性判断」能否做对的依据
//   4. 没有可提取主张的素材（如纯情绪素材）允许为空数组，不强制编造
//
// ⚠ 全项目只有这一个 claim 类型。历史上 material.ts 里另有一个 MaterialClaim
// （kind/text/source/note，为 scripts.claims 列預留但从未被使用），已合并进来。
// 保留两套结构会让 Phase 2 的跨素材聚合不得不同时兼容两种形状，代价远大于现在统一。
// 字段名沿用 MaterialClaim 的 kind/text/source 以承接既有设计，
// 并按 Creator Knowledge System 的需要补上 confidence 与适用场景。

/** 主张种类 */
export type ClaimKind = '事实' | '数据' | '观点' | '经历'

export const CLAIM_KINDS: readonly ClaimKind[] = ['事实', '数据', '观点', '经历']

export const CLAIM_KIND_LABELS: Record<ClaimKind, string> = {
  事实: '事实',
  数据: '数据',
  观点: '观点',
  经历: '经历',
}

export interface KnowledgeClaim {
  /** 命题本体（完整句子，如"AI 不会取代老师，而是把老师从重复劳动中解放出来"） */
  text: string
  /** 主张种类 */
  kind: ClaimKind
  /** 可信度 0-1：有明确出处/可验证的高，纯主观断言的低 */
  confidence: number
  /** 来源出处（URL/书名/人名等，素材未提及则省略） */
  source?: string
  /** 适用场景：决定这条主张在什么选题下才该被引用（不超过 3 个） */
  applicableScopes?: string[]
}

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

  /**
   * 素材中的知识主张（事实/数据/观点/经历）。
   * 真源存在 knowledge jsonb 内部，随 knowledge 一起被读写，避免与
   * scripts.claims 列形成两份打架的数据。
   */
  claims?: KnowledgeClaim[]

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
/**
 * 兜底清洗 claims 数组。
 *
 * 四条硬规则：
 *   1. 命题为空的主张直接丢弃（宁缺毋滥，避免脏数据污染知识聚合）
 *   2. kind 非法时兜底为"观点"，而不是丢弃 —— 抽出来但没分类比没抽出来强
 *   3. 最多 5 条：单条素材的主张承载能力有限，超量通常是 LLM 把同一意思拆了多次
 *   4. 同素材内按 text 去重
 * confidence 缺省 0.4：既不信 LLM 的默认乐观值，也不直接判死。
 */
export function normalizeClaims(raw: unknown, maxLen = 5): KnowledgeClaim[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: KnowledgeClaim[] = []

  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const c = item as Record<string, unknown>

    // 兼容 statement/type 旧字段别名
    const text = s(c.text ?? c.statement, 300)
    // 命题是 claim 的全部价值所在，缺了就没有意义
    if (!text) continue
    if (seen.has(text)) continue

    const kindRaw = c.kind ?? c.type
    const kind: ClaimKind =
      typeof kindRaw === 'string' && (CLAIM_KINDS as readonly string[]).includes(kindRaw)
        ? (kindRaw as ClaimKind)
        : '观点'

    const scopes = Array.isArray(c.applicableScopes)
      ? (c.applicableScopes as unknown[])
          .map((v) => s(v, 40))
          .filter((v): v is string => Boolean(v))
          .slice(0, 3)
      : []

    seen.add(text)
    out.push({
      text,
      kind,
      confidence: num(c.confidence, 0, 1, 0.4),
      source: s(c.source, 200) || undefined,
      applicableScopes: scopes.length > 0 ? scopes : undefined,
    })

    if (out.length >= maxLen) break
  }
  return out
}

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

  const claims = normalizeClaims(o.claims)

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
    claims: claims.length > 0 ? claims : undefined,
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
