// ============================================================
// KnowledgeAnalyzer —— 素材入库前的 AI 理解流程
//
// 设计原则：
//   1. 素材入库必须经过 AI 理解，生成 KnowledgeItem 后才写入 scripts.knowledge
//   2. AI 先判断信息是否足够，不足时提出 1-3 个关键问题
//   3. 问题形式优先选择式，降低用户思考成本
//   4. 失败静默降级：LLM 调用失败 → 返回 null，素材照常保存但无 knowledge
//   5. 与 FeedbackAnalyzer/IntentClarity 同模式：LLM 调用 + normalize 兜底
// ============================================================

import { callDeepSeekChat } from '@/lib/llm'
import {
  KNOWLEDGE_DIMENSIONS,
  normalizeClaims,
  type KnowledgeItem,
} from './knowledgeItem'

// 使用 DeepSeek 官方通道（与项目其他 15+ 个分析器一致，走 lib/llm.ts 统一封装）。
// 历史上这里走过硅基流动 deepseek-ai/DeepSeek-V3，实测延迟 3s~36s 且极不稳定；
// 官方 deepseek-chat 同任务稳定在 0.5~1.2s。
const MODEL_NAME = 'deepseek-chat'

/** LLM 请求超时：素材分析是用户同步等待路径，30s 兜底快速降级 */
const LLM_TIMEOUT_MS = 30_000

// ── 1. 类型定义 ───────────────────────────────────────────

/** AI 分析素材的输入 */
export interface AnalyzeKnowledgeInput {
  content: string // 用户输入的原始素材
  category?: string // 用户选择的 category（可选 hint）
  /** 用户对澄清问题的回答（第二次调用时传入） */
  clarifications?: Array<{ question_id: string; answer: string }>
}

/** AI 分析素材的输出 */
export interface AnalyzeKnowledgeResult {
  /** 是否需要进一步澄清 */
  needs_clarification: boolean
  /** 澄清问题（needs_clarification=true 时有值） */
  questions?: KnowledgeClarificationQuestion[]
  /** KnowledgeItem（needs_clarification=false 时有值） */
  knowledge?: KnowledgeItem
  /** AI 降级标记（true 时表示 LLM 失败，调用方应走 fallback） */
  degraded?: boolean
}

/** 澄清问题 */
export interface KnowledgeClarificationQuestion {
  id: string // 'usage' | 'content' | 'audience'
  question: string
  options: string[]
  allowCustom: boolean
}

// ── 2. LLM Prompt 构造 ─────────────────────────────────────

function buildSystemPrompt(): string {
  return `你是一个素材理解助手。你的任务是分析用户提供的素材（文案/段落/句子），输出结构化的 KnowledgeItem。

## 输出格式

严格输出 JSON，不要包含任何其他文本、不要 markdown 代码块标记。

### 场景 A：信息足够，直接生成 KnowledgeItem

\`\`\`json
{
  "needs_clarification": false,
  "knowledge": {
    "meaning": "AI 理解该素材的意义（1-2 句话）",
    "context": "使用场景描述",
    "content_type": "AI 判断素材用途（自由文本）",
    "content_tags": ["电影"],
    "thought_tags": ["人性"],
    "emotion_tags": ["震撼"],
    "expression_tags": ["故事化"],
    "usage_tags": ["开头钩子"],
    "audience_tags": ["电影爱好者"],
    "emotion_profile": "情绪的细粒度描述（可选）",
    "thought_profile": "思想的细粒度描述（可选）",
    "creation_usage": "创作用途详述（可选）",
    "claims": [
      {
        "text": "AI 不会取代老师，而是把老师从重复劳动中解放出来",
        "kind": "观点",
        "confidence": 0.8,
        "source": "素材明确表述，无外部出处",
        "applicableScopes": ["AI 教育", "教育类内容"]
      }
    ],
    "confidence": 0.85
  }
}
\`\`\`

### claims（知识主张）—— Creator Knowledge System 的上游燃料

6 维标签回答"这条素材是什么类型"，claims 回答"这条素材到底说了什么"。二者不可互相替代。

每条 claim 是一个**完整命题**，字段：
- text: string —— 完整句子形式的命题，禁止写成词组或标签
- kind: '事实'（客观事实）| '数据'（数据/统计）| '观点'（观点判断）| '经历'（个人经历）
- confidence: number —— 0-1；有明确出处或可验证的给 0.8+，纯主观断言给 0.4-0.6
- source: string —— 素材内提及的出处，没有则填空字符串
- applicableScopes: string[] —— 适用场景（决定在什么选题下才该引用），最多 3 个，没有则空数组

抽取要求：
- 优先抽"这条素材到底说了什么"，而不是它属于什么类别
- kind="观点" 尤其重要：用户表达出的立场必须保留原意，禁止概括成中性标签
  （反例：把"AI 不是取代老师，而是辅助老师"缩写成"AI 与教育"）
- 宁缺毋滥：没有明确主张时给空数组，禁止把 meaning 换种说法重复塞进来

### 场景 B：信息不足，需要澄清

\`\`\`json
{
  "needs_clarification": true,
  "questions": [
    {
      "id": "usage",
      "question": "这句话主要用于什么？",
      "options": ["视频开场", "文章观点", "标题", "案例素材"],
      "allowCustom": true
    }
  ]
}
\`\`\`

## 6 维标签枚举（必须只从这些值中选，每维 1-3 个）

### content_tags（内容标签）
${KNOWLEDGE_DIMENSIONS.content.values.join(' / ')}

### thought_tags（思想标签）
${KNOWLEDGE_DIMENSIONS.thought.values.join(' / ')}

### emotion_tags（情绪标签）
${KNOWLEDGE_DIMENSIONS.emotion.values.join(' / ')}

### expression_tags（表达方式标签）
${KNOWLEDGE_DIMENSIONS.expression.values.join(' / ')}

### usage_tags（创作用途标签）
${KNOWLEDGE_DIMENSIONS.usage.values.join(' / ')}

### audience_tags（受众标签）
${KNOWLEDGE_DIMENSIONS.audience.values.join(' / ')}

## 规则

1. **信息足够判断**：素材内容清晰、用途明确 → 直接生成 KnowledgeItem
2. **信息不足**：素材太短（<10 字）、用途模糊（如"今天给大家推荐一部吓死过人的恐怖片"可能是开头钩子/标题/观点）→ 提 1-3 个澄清问题
3. **最多 3 个问题**，优先问 usage（用途），其次 content（内容类型），最后 audience（受众）
4. **问题形式**：必须是选择式（2-4 个选项），allowCustom=true
5. **confidence**：0-1 之间，<0.6 表示不确定
6. **tags 严格从枚举中选**，不要输出枚举外的值
7. **meaning 和 content_type 必须非空**
8. **content_tags 和 usage_tags 至少 1 个**
9. **claims 宁缺毋滥**：没有明确的事实/数据/观点/经历时给空数组，不要把 meaning 换个说法塞进去充当 claim`
}

function buildUserPrompt(input: AnalyzeKnowledgeInput): string {
  let prompt = `## 素材内容

${input.content}`

  if (input.category) {
    prompt += `\n\n## 用户选择的分类（参考）

${input.category}`
  }

  if (input.clarifications && input.clarifications.length > 0) {
    prompt += '\n\n## 用户对澄清问题的回答\n'
    for (const c of input.clarifications) {
      prompt += `\n- ${c.question_id}: ${c.answer}`
    }
    prompt += '\n\n请基于用户回答生成 KnowledgeItem（needs_clarification=false）。'
  }

  return prompt
}

// ── 3. 主函数：analyzeKnowledge ─────────────────────────────

/**
 * 调用 LLM 分析素材，返回 KnowledgeItem 或澄清问题。
 * 失败时返回 degraded=true，调用方应走 fallback（直接保存无 knowledge 的素材）。
 */
export async function analyzeKnowledge(
  input: AnalyzeKnowledgeInput
): Promise<AnalyzeKnowledgeResult> {
  // callDeepSeekChat 内置超时/错误处理/key 检查，失败统一返回 { ok:false }
  const res = await callDeepSeekChat({
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(input) },
    ],
    temperature: 0.3,
    // 1000 → 1400：claims 每条都是完整命题，token 消耗明显高于标签枚举
    max_tokens: 1400,
    jsonMode: true,
    timeoutMs: LLM_TIMEOUT_MS,
  })

  if (!res.ok) {
    console.error('knowledgeAnalyzer: LLM 调用失败:', res.error)
    return { needs_clarification: false, degraded: true }
  }

  // 解析 JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(res.content)
  } catch {
    // 尝试提取 JSON 块
    const match = res.content.match(/\{[\s\S]*\}/)
    if (!match) {
      return { needs_clarification: false, degraded: true }
    }
    try {
      parsed = JSON.parse(match[0])
    } catch {
      return { needs_clarification: false, degraded: true }
    }
  }

  return normalizeAnalyzeResult(parsed)
}

// ── 4. 兜底清洗 ───────────────────────────────────────────

function s(v: unknown, max: number): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''
}

function arr<T extends string>(v: unknown, allowed: readonly T[], maxLen: number): T[] {
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
 * 兜底清洗 LLM 输出。
 * 1. needs_clarification=true 但 questions 为空 → 修正为 false
 * 2. needs_clarification=false 但 knowledge 无效 → 降级 degraded
 * 3. questions 中的 options 少于 2 个 → 过滤该问题
 */
export function normalizeAnalyzeResult(raw: unknown): AnalyzeKnowledgeResult {
  if (typeof raw !== 'object' || raw === null) {
    return { needs_clarification: false, degraded: true }
  }
  const o = raw as Record<string, unknown>

  const needs_clarification = Boolean(o.needs_clarification ?? o.needsClarification)

  // 场景 B：需要澄清
  if (needs_clarification) {
    const questions = normalizeQuestions(o.questions)
    if (questions.length === 0) {
      // 矛盾态：说要澄清但没问题，降级为不澄清
      return { needs_clarification: false, degraded: true }
    }
    return { needs_clarification: true, questions }
  }

  // 场景 A：直接生成 KnowledgeItem
  const knowledge = normalizeKnowledgeFromLLM(o.knowledge)
  if (!knowledge) {
    return { needs_clarification: false, degraded: true }
  }

  return { needs_clarification: false, knowledge }
}

function normalizeQuestions(raw: unknown): KnowledgeClarificationQuestion[] {
  if (!Array.isArray(raw)) return []
  const result: KnowledgeClarificationQuestion[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const q = item as Record<string, unknown>
    const id = s(q.id, 30)
    const question = s(q.question, 200)
    const options = Array.isArray(q.options)
      ? q.options.filter((o) => typeof o === 'string' && o.trim()).slice(0, 4)
      : []
    if (!id || !question || options.length < 2) continue
    result.push({
      id,
      question,
      options: options.map((o) => String(o).trim().slice(0, 50)),
      allowCustom: Boolean(q.allowCustom ?? q.allow_custom ?? true),
    })
    if (result.length >= 3) break
  }
  return result
}

function normalizeKnowledgeFromLLM(raw: unknown): KnowledgeItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const meaning = s(o.meaning, 500)
  const context = s(o.context, 300)
  const content_type = s(o.content_type ?? o.contentType, 100)

  if (!meaning || !content_type) return null

  const claims = normalizeClaims(o.claims)

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
    // claims 最多 5 条；无主张的素材（如纯情绪素材）会得到 undefined，不写库
    claims: claims.length > 0 ? claims : undefined,
    confidence,
    analyzed_at: new Date().toISOString(),
    ai_model: MODEL_NAME,
    clarification_asked: false, // 由调用方在传 clarifications 后设置为 true
  }
}

// ── 5. 用户纠错重新分析 ──────────────────────────────────

/** 用户纠错重新分析的输入 */
export interface ReAnalyzeKnowledgeInput {
  /** 原始素材内容 */
  content: string
  /** 上一次 AI 分析结果（让 LLM 知道之前哪里错了） */
  previousKnowledge: KnowledgeItem
  /** 用户指出的错误（自由文本） */
  userCorrection: string
}

/**
 * 用户纠错后重新分析素材。
 *
 * 与 analyzeKnowledge 的关键差异：
 *   1. 不会走 clarification 路径（用户已经在纠错，AI 不该再反问）
 *   2. confidence 自动降 0.1（修正后的结果不如一次到位的可靠）
 *   3. 系统 prompt 明确告知"你之前的分析有误，请修正"
 */
export async function reAnalyzeKnowledge(
  input: ReAnalyzeKnowledgeInput
): Promise<{ knowledge: KnowledgeItem | null; degraded: boolean }> {
  const res = await callDeepSeekChat({
    messages: [
      { role: 'system', content: buildReAnalyzeSystemPrompt() },
      { role: 'user', content: buildReAnalyzeUserPrompt(input) },
    ],
    temperature: 0.3,
    // 同上：容纳 claims
    max_tokens: 1400,
    jsonMode: true,
    timeoutMs: LLM_TIMEOUT_MS,
  })

  if (!res.ok) {
    console.error('knowledgeAnalyzer: reAnalyze LLM 调用失败:', res.error)
    return { knowledge: null, degraded: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(res.content)
  } catch {
    const match = res.content.match(/\{[\s\S]*\}/)
    if (!match) return { knowledge: null, degraded: true }
    try {
      parsed = JSON.parse(match[0])
    } catch {
      return { knowledge: null, degraded: true }
    }
  }

  // re_analyze 模式下 LLM 只返回 knowledge（不会 clarification）
  const o = parsed as Record<string, unknown>
  const rawKnowledge = o.knowledge ?? parsed
  const knowledge = normalizeKnowledgeFromLLM(rawKnowledge)
  if (!knowledge) {
    return { knowledge: null, degraded: true }
  }

  // 纠错后 confidence 降 0.1（最低 0.3）
  return {
    knowledge: {
      ...knowledge,
      // 用户纠错的往往是标签或意义，不是主张本身。LLM 若这次没重述 claims，
      // 沿用旧的，避免一次纠错把历史主张静默清空。
      claims: knowledge.claims ?? input.previousKnowledge.claims,
      confidence: Math.max(0.3, knowledge.confidence - 0.1),
      clarification_asked: true, // 纠错也算一次"用户参与"
    },
    degraded: false,
  }
}

function buildReAnalyzeSystemPrompt(): string {
  return `你是一个素材理解助手。你之前对一段素材的分析有误，用户指出了问题。请根据用户反馈重新分析，输出修正后的 KnowledgeItem。

严格输出 JSON，不要包含任何其他文本、不要 markdown 代码块标记。输出格式：

\`\`\`json
{
  "knowledge": {
    "meaning": "AI 理解该素材的意义（1-2 句话）",
    "context": "使用场景描述",
    "content_type": "AI 判断素材用途（自由文本）",
    "content_tags": ["电影"],
    "thought_tags": ["人性"],
    "emotion_tags": ["震撼"],
    "expression_tags": ["故事化"],
    "usage_tags": ["开头钩子"],
    "audience_tags": ["电影爱好者"],
    "emotion_profile": "情绪的细粒度描述（可选）",
    "thought_profile": "思想的细粒度描述（可选）",
    "creation_usage": "创作用途详述（可选）",
    "claims": [
      {
        "text": "完整句子形式的命题（不要写成词组或标签）",
        "kind": "事实 | 数据 | 观点 | 经历",
        "confidence": 0.8,
        "source": "素材内提及的出处，没有则空字符串",
        "applicableScopes": ["适用场景"]
      }
    ],
    "confidence": 0.75
  }
}
\`\`\`

## claims 修正原则

- claims 是"这条素材到底说了什么"（事实/数据/观点/经历），不要写成标签
- 若用户的纠错涉及素材含义，请同步修正 claims；否则原样保留
- text 必须是完整命题；kind="观点" 要保留用户原立场，禁止概括为中性标签
- 没有明确主张时给空数组

## 6 维标签枚举（必须只从这些值中选，每维 1-3 个）

### content_tags（内容标签）
${KNOWLEDGE_DIMENSIONS.content.values.join(' / ')}

### thought_tags（思想标签）
${KNOWLEDGE_DIMENSIONS.thought.values.join(' / ')}

### emotion_tags（情绪标签）
${KNOWLEDGE_DIMENSIONS.emotion.values.join(' / ')}

### expression_tags（表达方式标签）
${KNOWLEDGE_DIMENSIONS.expression.values.join(' / ')}

### usage_tags（创作用途标签）
${KNOWLEDGE_DIMENSIONS.usage.values.join(' / ')}

### audience_tags（受众标签）
${KNOWLEDGE_DIMENSIONS.audience.values.join(' / ')}

## 规则

1. **严肃对待用户反馈**：用户指出的错误必须修正，不能保留原分析中用户认为错的部分
2. **但不要全盘否定**：用户没提到的维度可以保留原分析中的合理部分
3. **confidence**：修正后的结果应该比首次低 0.1-0.2（因为是事后修正）
4. **tags 严格从枚举中选**，不要输出枚举外的值
5. **meaning 和 content_type 必须非空**
6. **content_tags 和 usage_tags 至少 1 个**
7. 只输出 knowledge，不要 needs_clarification 或 questions（用户已经在纠错了，不要反问）`
}

function buildReAnalyzeUserPrompt(input: ReAnalyzeKnowledgeInput): string {
  const prev = input.previousKnowledge
  return [
    '## 原始素材内容',
    input.content,
    '',
    '## 你之前的分析结果（有误）',
    `意义：${prev.meaning}`,
    `用途：${prev.content_type}`,
    `content_tags: ${prev.content_tags.join('、')}`,
    `thought_tags: ${prev.thought_tags.join('、') || '（空）'}`,
    `emotion_tags: ${prev.emotion_tags.join('、') || '（空）'}`,
    `expression_tags: ${prev.expression_tags.join('、') || '（空）'}`,
    `usage_tags: ${prev.usage_tags.join('、') || '（空）'}`,
    `audience_tags: ${prev.audience_tags.join('、') || '（空）'}`,
    prev.creation_usage ? `创作用途详述：${prev.creation_usage}` : '',
    '',
    '## 用户指出的错误',
    input.userCorrection,
    '',
    '请根据用户反馈重新分析，输出修正后的 KnowledgeItem。',
  ].filter(Boolean).join('\n')
}
