// ============================================================
// Work Tag Analysis（作品标签分析）—— 阶段 4
//
// 作品生成后异步追加：对已生成正文做 13 字段结构化分析，
// 输出标签供展示和未来检索。标签用于"理解作品"，不限制创作。
//
// 13 字段 = 7 自由文本维度 + 6 枚举维度（content/thought/emotion/expression/usage/audience）
//   与 KnowledgeItem 6 维标签完全对齐，作品 DNA 和素材 DNA 同构
//
// 设计原则：
//   1. 异步：前端在收到生成结果后 fetch，不阻塞用户阅读
//   2. 轻量：max_tokens 1000，temperature 0.3（稳定判定）
//   3. 可选鉴权：登录用户结果存 generation_history.work_tags（jsonb，幂等）；
//      游客纯返回不落库
//   4. 失败静默：LLM 调用失败返回 null，前端降级不展示标签卡
// ============================================================

import {
  type ContentTag,
  type ThoughtTag,
  type EmotionTag,
  type ExpressionTag,
  type UsageTag,
  type AudienceTag,
  KNOWLEDGE_DIMENSIONS,
} from './knowledgeItem'
import { llmTimeoutSignal } from '@/lib/llm'

/** 作品标签分析结果（7 自由文本 + 6 枚举维度 = 13 字段） */
export interface WorkTags {
  // 7 自由文本维度：展示友好，描述性强
  work_type: string // 作品类型，如"电影解说""商业分析""知识科普"
  theme: string // 主题，如"AI 创业""悬疑电影心理""商业计划书"
  expression_style: string // 表达方式，如"故事化""深度分析""幽默吐槽"
  emotion: string // 情绪基调，如"紧张""温情""冷峻""热血"
  audience: string // 目标受众，如"创业者""家长""学生""同行专家"
  narrative_structure: string // 叙事结构，如"三幕结构""问题-方案""对比拆解"
  core_viewpoint: string // 核心观点，一句话
  // 6 枚举维度：与 KnowledgeItem 完全对齐，实现"作品 DNA"和"素材 DNA"同构
  content_tags: ContentTag[] // 内容标签（1-3 个）
  thought_tags: ThoughtTag[] // 思想标签（0-3 个，允许空）
  emotion_tags: EmotionTag[] // 情绪标签（1-3 个）
  expression_tags: ExpressionTag[] // 表达方式标签（1-3 个）
  usage_tags: UsageTag[] // 创作用途标签（1-3 个）
  audience_tags: AudienceTag[] // 受众标签（1-3 个）
  analyzedAt?: string // 服务端写入时间（落库时挂）
}

// ── 兜底清洗 ────────────────────────────────────────────────

function s(v: unknown, max: number): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''
}

/**
 * 枚举数组清洗：只保留合法枚举值，去重，限长。
 * 与 knowledgeItem.ts 的 arr 同语义，本文件自包含以避免循环依赖。
 */
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

/**
 * 兜底清洗 LLM 输出。
 * 无效返回 null：调用方降级为"不展示标签卡"，不阻塞主流程。
 *
 * 核心维度判定：
 *   - work_type + theme 必须有值（与原 7 维逻辑一致）
 *   - usage_tags 允许空（LLM 偶尔不返回时不至于让整张标签卡消失）
 *   - thought_tags 允许空（部分作品确实无明显思想指向，如纯科普）
 */
export function normalizeWorkTags(raw: unknown): WorkTags | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const work_type = s(o.work_type, 30)
  const theme = s(o.theme, 100)
  const expression_style = s(o.expression_style, 30)
  const emotion = s(o.emotion, 30)
  const audience = s(o.audience, 100)
  const narrative_structure = s(o.narrative_structure, 50)
  const core_viewpoint = s(o.core_viewpoint, 200)

  // 6 个枚举维度（与 KnowledgeItem 同枚举集合）
  const content_tags = arr(o.content_tags ?? o.contentTags, KNOWLEDGE_DIMENSIONS.content.values, 3)
  const thought_tags = arr(o.thought_tags ?? o.thoughtTags, KNOWLEDGE_DIMENSIONS.thought.values, 3)
  const emotion_tags = arr(o.emotion_tags ?? o.emotionTags, KNOWLEDGE_DIMENSIONS.emotion.values, 3)
  const expression_tags = arr(o.expression_tags ?? o.expressionTags, KNOWLEDGE_DIMENSIONS.expression.values, 3)
  const usage_tags = arr(o.usage_tags ?? o.usageTags, KNOWLEDGE_DIMENSIONS.usage.values, 3)
  const audience_tags = arr(o.audience_tags ?? o.audienceTags, KNOWLEDGE_DIMENSIONS.audience.values, 3)

  // work_type 和 theme 是最核心的两个维度，缺失视为无效
  if (!work_type || !theme) return null
  // content_tags 至少 1 个（与 KnowledgeItem content_tags 同等重要）
  if (!content_tags.length) return null

  return {
    work_type,
    theme,
    expression_style,
    emotion,
    audience,
    narrative_structure,
    core_viewpoint,
    content_tags,
    thought_tags,
    emotion_tags,
    expression_tags,
    usage_tags,
    audience_tags,
  }
}

// ── 服务端：标签分析 LLM 调用 ──────────────────────────────

/** 标签分析调用的服务端输入 */
export interface AnalyzeWorkTagsInput {
  /** 作品正文（截断到 8000 字，超过 LLM 上下文窗口） */
  sampleText: string
  /** 创作主题（辅助判断，如"AI 创业文章"） */
  topic?: string
}

const TAG_JSON_KEYS = [
  'work_type',
  'theme',
  'expression_style',
  'emotion',
  'audience',
  'narrative_structure',
  'core_viewpoint',
  'content_tags',
  'thought_tags',
  'emotion_tags',
  'expression_tags',
  'usage_tags',
  'audience_tags',
].join(', ')

// 6 个枚举维度（与 KnowledgeItem 完全对齐）
const CONTENT_TAG_ENUM = KNOWLEDGE_DIMENSIONS.content.values.join('、')
const THOUGHT_TAG_ENUM = KNOWLEDGE_DIMENSIONS.thought.values.join('、')
const EMOTION_TAG_ENUM = KNOWLEDGE_DIMENSIONS.emotion.values.join('、')
const EXPRESSION_TAG_ENUM = KNOWLEDGE_DIMENSIONS.expression.values.join('、')
const USAGE_TAG_ENUM = KNOWLEDGE_DIMENSIONS.usage.values.join('、')
const AUDIENCE_TAG_ENUM = KNOWLEDGE_DIMENSIONS.audience.values.join('、')

function buildTagSystemPrompt(): string {
  return [
    '你是内容分析专家。对用户提供的已生成作品做 13 字段结构化分析，只输出 JSON。',
    '',
    '7 个自由文本维度（描述性、展示友好）：',
    '1. work_type：作品类型（2-6 字），如"电影解说""商业分析""知识科普""创业分享"',
    '2. theme：主题（5-30 字），如"AI 创业""悬疑电影心理""商业计划书"',
    '3. expression_style：表达方式（2-6 字），如"故事化""深度分析""幽默吐槽""观点鲜明"',
    '4. emotion：情绪基调（2-4 字），如"紧张""温情""冷峻""热血""轻松"',
    '5. audience：目标受众（5-30 字），从正文口吻和内容推断',
    '6. narrative_structure：叙事结构（2-8 字），如"三幕结构""问题-方案""对比拆解""起承转合"',
    '7. core_viewpoint：核心观点（1 句话，20-80 字），作品最想传达的那个想法',
    '',
    '6 个枚举维度（与素材库同标签语言，必须从枚举中选）：',
    '8. content_tags：内容标签数组（1-3 个），枚举：' + CONTENT_TAG_ENUM,
    '9. thought_tags：思想标签数组（0-3 个），枚举：' + THOUGHT_TAG_ENUM + '（纯科普/工具类作品可为空数组）',
    '10. emotion_tags：情绪标签数组（1-3 个），枚举：' + EMOTION_TAG_ENUM,
    '11. expression_tags：表达方式标签数组（1-3 个），枚举：' + EXPRESSION_TAG_ENUM,
    '12. usage_tags：创作用途标签数组（1-3 个），枚举：' + USAGE_TAG_ENUM + '（回答"这篇作品适合用来做什么"）',
    '13. audience_tags：受众标签数组（1-3 个），枚举：' + AUDIENCE_TAG_ENUM,
    '',
    '硬性要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    '2. 所有字符串字段使用中文；',
    '3. JSON 必须严格包含以下 key：',
    TAG_JSON_KEYS,
    '4. work_type 和 theme 和 content_tags 必须有值；thought_tags 可以为空数组；',
    '5. 6 个 *_tags 必须是数组，且元素必须在对应枚举内，不要返回字符串；',
    '6. 不要编造正文里不存在的内容，标签必须有正文依据。',
  ].join('\n')
}

function buildTagUserPrompt(input: AnalyzeWorkTagsInput): string {
  return [
    '请分析以下已生成作品，输出 13 字段标签：',
    '',
    input.topic ? `创作主题：${input.topic}` : '',
    '',
    '--- 作品正文 ---',
    input.sampleText.slice(0, 8000),
    '--- 正文结束 ---',
  ].filter(Boolean).join('\n')
}

/**
 * 调用 DeepSeek 分析作品标签（强制 JSON 输出）。
 * 仅服务端使用；失败返回 null，调用方降级为"不展示标签卡"。
 *
 * 温度 0.3：标签需要稳定性，同一作品不应反复给出不同标签。
 * max_tokens 1000：13 字段标签 + 6 个数组枚举，比 9 维多约 50% 输出量。
 */
export async function analyzeWorkTags(
  input: AnalyzeWorkTagsInput
): Promise<WorkTags | null> {
  const text = input.sampleText.trim()
  if (text.length < 20) return null // 正文过短无法分析

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        signal: llmTimeoutSignal(1000),
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: buildTagSystemPrompt() },
            { role: 'user', content: buildTagUserPrompt(input) },
          ],
          temperature: 0.3,
          max_tokens: 1000,
          response_format: { type: 'json_object' },
        }),
      })

      if (!res.ok) {
        console.error('作品标签分析失败:', await res.text())
        return null
      }
      const data = await res.json()
      const raw: string = data?.choices?.[0]?.message?.content ?? ''
      if (!raw.trim()) return null

      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
      const parsed = normalizeWorkTags(JSON.parse(cleaned))
      if (parsed) return parsed
    } catch (e) {
      console.error(`作品标签分析异常（第 ${attempt + 1} 次）:`, e)
    }
  }
  return null
}
