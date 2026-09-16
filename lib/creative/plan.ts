// ============================================================
// Creative Plan（创作方案）—— 灵感场生成重构的"方向层"产物
//
// 与旧蓝图（CreativeBlueprint）的关系：
//   蓝图是"提交后只读展示"；Plan 是"生成前 AI 建议、用户可改可确认"。
//   用户确认后由 freezePlan() 冻结映射回蓝图超集（FrozenPlan），
//   继续走现有 blueprints 字段透传 / generation_history.blueprint jsonb 落库，
//   版本管理、定向迭代、诊断卡全部零破坏兼容。
//
// 本模块为纯类型 + 纯函数 + 服务端 LLM 调用，前端只 import 类型与冻结工具。
// ============================================================

import {
  normalizeProblem,
  type CreativeBlueprint,
  type ProblemUnderstanding,
} from './blueprint'
import { parseCreatorReport, type CreatorReport, type DnaItem } from './creatorReport'
import type { ClarificationAnswer } from './intentClarity'
import { KNOWLEDGE_DIMENSIONS, type UsageTag } from './knowledgeItem'

/** 语言风格三维（结构化，替代旧的自由文本书写） */
export interface PlanLanguageStyle {
  pace: string // 节奏：快速 / 舒缓 / 张弛有度…
  mood: string // 情绪：紧张 / 温情 / 冷峻 / 热血…
  expression: string // 表达：故事化 / 深度分析 / 幽默吐槽…
}

/** 一个备选创作方向：三个方向各自携带全套细节，切换方向即整体替换，无需二次调用 */
export interface PlanDirection {
  key: string // 'A' | 'B' | 'C'
  title: string // 方向名，如：恐惧心理解析
  desc: string // 一句话说明这个方向讲什么、适合什么
  viewpoint: string // 动作化创作视角，如"从人物恐惧心理解析电影"（禁止身份标签）
  structure: string[] // 该方向专属叙事结构 3-6 步
  emotion_curve: string
  opening_hook: string
  core_conflict: string
  ending: string
  strategy: string
  language_style: PlanLanguageStyle
}

/** AI 创作方案（生成前的建议卡片数据） */
export interface CreativePlan {
  content_type: string // 内容类型（优先取平台枚举；不匹配时 AI 可提议）
  content_type_reason: string // 适合原因（一句话，可验证、不空泛）
  target_audience: string // 目标观众画像
  directions: PlanDirection[] // 恰好 3 个显著不同的切入方向
  recommended_direction_key: string // AI 预选方向 key（我的模式优先个性化方向）
  word_count_options: number[] // 3 个字数档
  recommended_word_count: number // 推荐字数档（必须是三档之一）
  /**
   * 阶段 3：AI 推断本次创作的素材用途标签（1 个）。
   * 替代 CATEGORY_TO_USAGE 映射——让 AI 直接输出，比 category 映射更准确。
   * 枚举值来自 KNOWLEDGE_DIMENSIONS.usage（剧情素材/观点素材/案例素材/结构参考/情绪铺垫/开头钩子）。
   */
  usage_tag?: UsageTag
  /**
   * 仅我的模式：基于真实数据的个性化推荐解释，如
   * "你近 12 篇作品中 8 篇从人物心理切入，因此优先推荐方向 A"。
   * 灵感模式 / 数据不足时为空串，前端不渲染该行。
   */
  personal_reason: string
  /**
   * 问题理解（问题分析层）：AI 对"用户想解决什么问题"的拆解。
   * LLM 偶发漏字段时缺失，不阻塞方案卡展示。
   */
  problem?: ProblemUnderstanding
}

/** 用户在建议卡片上的手动修改（未改的字段不传，冻结时用 AI 推荐值） */
export interface PlanEdits {
  directionKey?: string // 改选方向
  contentType?: string // 修改内容类型
  viewpoint?: string // 修改创作视角（作用于选中方向）
  wordCount?: number // 修改字数档
  languageStyle?: Partial<PlanLanguageStyle> // 修改语言风格三维
}

/**
 * 冻结后的方案 = 蓝图超集。
 * 旧字段全部保留（进化系统/版本/诊断无感），新字段 optional 追加。
 */
export interface FrozenPlan extends CreativeBlueprint {
  content_type?: string
  language_style?: PlanLanguageStyle
  word_count?: number
  usage_tag?: UsageTag
  problem_understanding?: ProblemUnderstanding
  /**
   * 阶段 3：用户澄清回答（原始值，来自 ClarifyPanel）。
   * 与 problem_understanding 中的 AI 最终产出并存——
   * clarifications 是用户说了什么，problem_understanding 是 AI 最终理解了什么。
   * 跨设备恢复时用 clarifications 重新走澄清态。
   */
  clarifications?: ClarificationAnswer[]
}

// ── 兜底清洗 ────────────────────────────────────────────────

function s(v: unknown, max = 500): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''
}

function num(v: unknown, min: number, max: number): number | null {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const rounded = Math.round(n)
  return rounded >= min && rounded <= max ? rounded : null
}

function normalizeLanguageStyle(v: unknown): PlanLanguageStyle {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  return {
    pace: s(o.pace, 30),
    mood: s(o.mood, 30),
    expression: s(o.expression, 30),
  }
}

function normalizeDirection(raw: unknown, index: number): PlanDirection | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const structure = Array.isArray(o.structure)
    ? o.structure
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter(Boolean)
        .slice(0, 6)
    : []

  const d: PlanDirection = {
    key: s(o.key, 5) || String.fromCharCode(65 + index),
    title: s(o.title, 40),
    desc: s(o.desc, 200),
    viewpoint: s(o.viewpoint, 100),
    structure,
    emotion_curve: s(o.emotion_curve, 200),
    opening_hook: s(o.opening_hook, 300),
    core_conflict: s(o.core_conflict, 200),
    ending: s(o.ending, 200),
    strategy: s(o.strategy, 200),
    language_style: normalizeLanguageStyle(o.language_style),
  }

  // 方向至少要有标题与视角，否则视为无效（LLM 偶发漏字段时保底）
  if (!d.title || !d.viewpoint) return null
  return d
}

/** LLM 返回值兜底；无效方案返回 null，调用方降级为手动参数路径 */
export function normalizePlan(raw: unknown): CreativePlan | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const directions = Array.isArray(o.directions)
    ? o.directions
        .slice(0, 3)
        .map((d, i) => normalizeDirection(d, i))
        .filter((d): d is PlanDirection => d !== null)
    : []
  if (directions.length === 0) return null

  // 字数档：过滤有效整数，去重保序，不足三档用空补齐交给前端容错
  const wordOptions = Array.isArray(o.word_count_options)
    ? Array.from(
        new Set(
          o.word_count_options
            .map((w) => num(w, 100, 5000))
            .filter((w): w is number => w !== null)
        )
      ).slice(0, 3)
    : []
  if (wordOptions.length === 0) return null
  const recommendedWord =
    wordOptions.find((w) => w === num(o.recommended_word_count, 100, 5000)) ??
    wordOptions[Math.min(wordOptions.length - 1, 1)]

  const keys = new Set(directions.map((d) => d.key))
  const recommendedKey = keys.has(s(o.recommended_direction_key, 5))
    ? s(o.recommended_direction_key, 5)
    : directions[0].key

  const contentType = s(o.content_type, 30)
  if (!contentType) return null

  // 问题理解：缺失时为 undefined，方案卡照常展示
  const problem = normalizeProblem(o.problem)

  // usage_tag：从枚举中选，不匹配则为 undefined（兜底用 CATEGORY_TO_USAGE）
  const usageValues = KNOWLEDGE_DIMENSIONS.usage.values as readonly string[]
  const rawUsage = typeof o.usage_tag === 'string' ? o.usage_tag.trim() : ''
  const usage_tag = usageValues.includes(rawUsage) ? (rawUsage as UsageTag) : undefined

  return {
    content_type: contentType,
    content_type_reason: s(o.content_type_reason, 200),
    target_audience: s(o.target_audience, 100),
    directions,
    recommended_direction_key: recommendedKey,
    word_count_options: wordOptions,
    recommended_word_count: recommendedWord,
    ...(usage_tag ? { usage_tag } : {}),
    personal_reason: s(o.personal_reason, 300),
    ...(problem ? { problem } : {}),
  }
}

/**
 * 用户确认方案：把 AI 建议 + 用户修改 + 用户澄清回答冻结为蓝图超集。
 * 纯函数，无 LLM / IO；前端在点击"使用方案，生成文章"时调用。
 *
 * 阶段 3：clarifications 来自用户澄清面板的原始回答。
 * - 直接挂到 FrozenPlan.clarifications 落库（供跨设备恢复）
 * - 同时把 clarifications 中的 scenario 注入 problem_understanding
 *   （AI 可能没输出 scenario，但用户明确说了使用场景）
 */
export function freezePlan(
  plan: CreativePlan,
  edits?: PlanEdits,
  clarifications?: ClarificationAnswer[]
): FrozenPlan {
  const selectedKey = edits?.directionKey ?? plan.recommended_direction_key
  const direction =
    plan.directions.find((d) => d.key === selectedKey) ?? plan.directions[0]

  const languageStyle: PlanLanguageStyle = {
    pace: edits?.languageStyle?.pace ?? direction.language_style.pace,
    mood: edits?.languageStyle?.mood ?? direction.language_style.mood,
    expression: edits?.languageStyle?.expression ?? direction.language_style.expression,
  }

  const viewpoint = edits?.viewpoint?.trim() || direction.viewpoint
  const contentType = edits?.contentType?.trim() || plan.content_type

  // 阶段 3：从 clarifications 中提取 scenario，覆盖 problem_understanding.scenario
  // 用户明确说了"使用场景=小红书"，AI 不能把它改成"公众号"——用户回答优先于 AI 推断
  let problemUnderstanding = plan.problem
  if (problemUnderstanding && clarifications?.length) {
    const scenarioAnswer = clarifications.find((c) => c.dimension === 'scenario')
    if (scenarioAnswer?.answer) {
      problemUnderstanding = {
        ...problemUnderstanding,
        scenario: scenarioAnswer.answer,
      }
    }
  }

  return {
    // ── 旧蓝图字段（进化系统/版本/诊断继续读这些）──
    title_direction: direction.title,
    positioning: direction.desc ? `${direction.title}：${direction.desc}` : direction.title,
    target_audience: plan.target_audience,
    structure: direction.structure,
    emotion_curve: direction.emotion_curve,
    opening_hook: direction.opening_hook,
    core_conflict: direction.core_conflict,
    ending: direction.ending,
    strategy: direction.strategy,
    persona_hint: viewpoint,
    // ── 超集新字段 ──
    content_type: contentType,
    language_style: languageStyle,
    word_count: edits?.wordCount ?? plan.recommended_word_count,
    // 阶段 3：AI 推断的素材用途标签（替代 CATEGORY_TO_USAGE 映射）
    ...(plan.usage_tag ? { usage_tag: plan.usage_tag } : {}),
    // 问题理解随冻结方案落库（generation_history.blueprint jsonb，零表结构变更）
    problem_understanding: problemUnderstanding,
    // 阶段 3：用户澄清回答原始值（跨设备恢复用）
    ...(clarifications?.length ? { clarifications } : {}),
  }
}

// ── 服务端：方案生成 Prompt ─────────────────────────────────

/**
 * 把用户澄清回答格式化为注入 prompt 的文本块。
 * 阶段 2 注入点：澄清回答优先级高于 AI 推断，覆盖 problem 对应字段。
 *
 * dimension 到 ProblemUnderstanding 字段的映射：
 *   goal → user_goal
 *   audience → target_audience（plan 层）/ problem.user_identity 侧写
 *   scenario → 影响 directions 的场景适配
 *   identity → user_identity
 *   criteria → success_criteria
 *
 * 注意：不在此处覆盖 problem 字段（LLM 仍会输出 problem），
 * 而是把用户回答作为"硬约束"注入，LLM 必须让 problem 字段反映用户回答。
 */
function formatClarificationsForPrompt(answers: ClarificationAnswer[]): string {
  const labels: Record<string, string> = {
    goal: '用户目标（必须反映到 problem.user_goal）',
    audience: '目标受众（必须反映到 plan.target_audience 与 problem.user_identity）',
    scenario: '使用场景（必须反映到 directions 的场景适配）',
    identity: '用户身份（必须反映到 problem.user_identity）',
    criteria: '评价标准（必须反映到 problem.success_criteria）',
  }
  const lines = answers
    .filter((a) => a && typeof a.dimension === 'string' && typeof a.answer === 'string')
    .map((a) => `- ${labels[a.dimension] ?? a.dimension}：${a.answer}`)
  if (lines.length === 0) return ''
  return `【用户澄清回答（硬约束，覆盖任何 AI 推断）】\n${lines.join('\n')}`
}

/** 生成方案的服务端输入（由 API 层完成鉴权/装配后传入） */
export interface GeneratePlanInput {
  topic: string
  /** 平台现有内容类型枚举（content_type 优先从中选择） */
  categoryOptions: readonly string[]
  /** 灵感模式 / 我的模式（影响 system 口径与个性化要求） */
  mode: 'inspiration' | 'creator'
  /** 我的模式：长期专属伙伴身份锚定（buildCreatorIdentity().forWriter）；灵感模式为空 */
  creatorIdentityText?: string
  /** 我的模式：风格卡 + 创作者人格装配文本；灵感模式为空 */
  styleProfileText?: string
  /** 我的模式：仅含真实事实的证据清单（personal_reason 只允许引用其中事实）；无数据为空 */
  evidenceText?: string
  /** 我的模式：近期同主题旧作摘录（方向个性化参考）；无数据为空 */
  recentWorksText?: string
  /** 高级设置：用户本次显式补充（两个模式都生效，优先级最高） */
  hints?: { contentType?: string; style?: string }
  /** 登场角色约束块（已格式化文本；空串 = 无角色） */
  charactersText?: string
  /**
   * 意图澄清用户回答（阶段 2 注入点）。
   * 来自 /api/creative/plan 的两阶段路由——judgeIntentClarity 判定需要澄清后，
   * 用户在 ClarifyPanel 选择/自定义回答，回答会覆盖 problem 对应字段的 AI 推断值。
   * undefined 时：走原单次生成路径，无行为变化。
   */
  clarifications?: ClarificationAnswer[]
}

const PLAN_JSON_KEYS = [
  'content_type',
  'content_type_reason',
  'target_audience',
  'directions',
  'recommended_direction_key',
  'word_count_options',
  'recommended_word_count',
  'usage_tag',
  'personal_reason',
  'problem',
].join(', ')

function buildSystemPrompt(creatorMode: boolean): string {
  return [
    '你是资深短视频内容策划总监，擅长只凭一个主题就为创作者设计高完播率的内容方案。',
    '你的任务：理解用户主题，产出一份结构化"创作方案"——包含内容类型判断、3 个显著不同的创作方向、每个方向的创作视角/叙事结构/语言风格，以及字数建议。',
    '硬性要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    '2. 所有字符串字段使用中文；directions 必须是长度恰好为 3 的数组；word_count_options 为 3 个 100-5000 的正整数；',
    '3. 三个方向必须是同一主题下显著不同的切入角度（如：心理解析 / 冲突拆解 / 商业分析），禁止只换措辞的同质方向；每个方向都要能独立成片；',
    '4. viewpoint（创作视角）必须是"分析/讲述动作"，禁止使用身份标签：',
    '   错误示例："深度影评人""科普博主"（这是标签，不是视角）；',
    '   正确示例："从人物恐惧心理解析电影""按三幕结构拆解剧情漏洞""从票房与工业流水线角度分析商业片"；',
    '5. content_type_reason 必须给出可验证的具体原因（题材元素/受众预期/内容形态），禁止"引人入胜""精彩绝伦"这类空话；opening_hook 要给出具体写法或示例句；',
    '6. JSON 必须严格包含以下 key：',
    PLAN_JSON_KEYS,
    '   directions 每项必须包含：key, title, desc, viewpoint, structure, emotion_curve, opening_hook, core_conflict, ending, strategy, language_style；',
    '   language_style 为对象，包含 pace, mood, expression 三个短词字段；',
    '   三个方向的 key 依次为 "A"、"B"、"C"。',
    creatorMode
      ? '7. 你是这位创作者的长期专属创作伙伴：recommended_direction_key 优先选择最贴合其创作 DNA 的方向，并在 personal_reason 中用给定的真实数据解释原因；另外两个方向用于帮 ta 探索新表达。'
      : '7. 基于平台高完播内容的通用创作经验做判断；personal_reason 必须输出空字符串 ""。',
    '8. 你必须同时完成"问题理解"：用户输入可能不只是创作主题，而是"想解决什么问题"（如"我想写爆款电影解说""我想做商业计划书""我想学计算机"）。输出 problem 对象，包含：',
    '   problem_type（问题类型 2-8 字，如"内容创作问题""商业规划问题""学习规划问题"）；',
    '   is_content_creation（布尔：该问题是否属于文案/内容/解说创作——这是当前平台能直接生成成品的范围）；',
    '   user_goal（用户为什么需要它，一句话，如"获得投资人认可"）；',
    '   task_breakdown（3-6 条要解决的核心子任务，具体不空泛）；',
    '   user_identity（用户身份推断与所需表达方式，一句话，如"创业者，需要专业商业语言"）；',
    '   recommended_role（最优 AI 角色，一句完整的角色设定，如"拥有10年以上创业咨询经验的商业顾问"，禁止空泛标签）；',
    '   role_reason（为什么是这个角色，一句话）；',
    '   success_criteria（怎样算做好了，一句话，可验证）；',
    '   professional_prompt（100-200 字完整自然语言专业 Prompt，可直接复制给任何大模型使用：包含角色、视角、任务拆解、输出要求；禁止"身份：xx 风格：xx"式标签罗列）',
    '9. is_content_creation 为 false 时，directions/content_type 等仍按"如果用户想把它做成内容"的探索口径输出（不得输出空数组）。',
    '10. usage_tag（素材用途标签，从以下枚举中选 1 个，帮助知识库检索对齐素材）：' + KNOWLEDGE_DIMENSIONS.usage.values.join(' / '),
    '   选择依据：本次创作最主要需要哪类素材（电影解说→剧情素材，商业分析→观点素材，商业计划书→结构参考）。',
  ].join('\n')
}

function buildUserPrompt(input: GeneratePlanInput): string {
  const lines: string[] = []
  lines.push('请为以下创作主题设计完整方案：')
  lines.push('')
  lines.push(`创作主题：${input.topic}`)
  lines.push(`平台现有内容类型（content_type 优先从中选择；都不贴合时可自拟一个准确的短类型名）：${input.categoryOptions.join('、')}`)
  if (input.hints?.contentType) lines.push(`用户本次显式指定内容类型（最高优先级，content_type 必须采用）：${input.hints.contentType}`)
  if (input.hints?.style) lines.push(`用户本次显式风格补充（在各方向的 language_style 中体现）：${input.hints.style}`)
  lines.push('')
  lines.push('字段要求：')
  lines.push('- content_type_reason：一句话说明为什么适合该类型（点出题材中的具体元素）')
  lines.push('- target_audience：一句话观众画像')
  lines.push('- directions：3 个方向；每个方向的 structure 给 4-6 个按顺序的段落任务（如"Hook：用悬念场景开场"）')
  lines.push('- word_count_options：结合该主题的表达容量给短/中/长三档（如 800/1200/2000），recommended_word_count 必须是三档之一')
  lines.push('- language_style.pace/mood/expression 各用 2-6 个汉字的短词')
  lines.push('- problem：先判断用户"想解决什么问题"再给方案；is_content_creation=false 时方案部分按"做成内容"的探索口径输出')
  lines.push('- usage_tag：从枚举中选 1 个（' + KNOWLEDGE_DIMENSIONS.usage.values.join(' / ') + '），帮助知识库检索对齐素材用途')

  // 阶段 2：用户澄清回答作为硬约束注入，覆盖 AI 对 problem 字段的推断
  const clarificationsBlock = input.clarifications?.length
    ? formatClarificationsForPrompt(input.clarifications)
    : ''
  if (clarificationsBlock) lines.push('', clarificationsBlock)

  if (input.creatorIdentityText) lines.push(`\n${input.creatorIdentityText}`)
  if (input.styleProfileText) lines.push(`\n${input.styleProfileText}`)
  if (input.evidenceText) lines.push(`\n${input.evidenceText}`)
  if (input.recentWorksText) lines.push(`\n${input.recentWorksText}`)
  if (input.charactersText) {
    lines.push(`\n${input.charactersText}`)
    lines.push('请让至少一个方向围绕上述角色设计（在该方向的 structure、core_conflict 中体现角色位置），其余方向可自由发挥。')
  }

  if (input.mode === 'creator') {
    lines.push('')
    lines.push('personal_reason 规则（必须严格遵守）：')
    lines.push('- 只能引用上方"真实证据清单"中出现的数字与主题名，禁止编造任何篇数、比例、标签；')
    lines.push('- 证据不足（清单为空或无法支撑个性化判断）时输出空字符串 ""；')
    lines.push('- 句式面向用户、具体可感知，例如"你的 12 篇作品里 8 篇是人物心理切入，方向 A 最像你会写的"。')
  }

  return lines.join('\n')
}

/**
 * 调用 DeepSeek 生成创作方案（强制 JSON）。
 * 仅服务端使用；失败返回 null，调用方降级为手动参数生成，不阻断主流程。
 * LLM 偶发返回非合法 JSON（尤其长输出被截断时），此处做最多 3 次尝试。
 */
export async function generatePlan(input: GeneratePlanInput): Promise<CreativePlan | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: buildSystemPrompt(input.mode === 'creator') },
            { role: 'user', content: buildUserPrompt(input) },
          ],
          temperature: 0.6,
          max_tokens: 4000, // 问题理解 + 三方向方案，较原 3000 增加余量
          response_format: { type: 'json_object' },
        }),
      })

      if (!res.ok) {
        console.error('创作方案生成失败:', await res.text())
        return null
      }
      const data = await res.json()
      const text: string = data?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim()) return null

      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const parsed = normalizePlan(JSON.parse(cleaned))
      if (parsed) return parsed
      // normalizePlan 返回 null 说明字段不全，重试
    } catch (e) {
      console.error(`创作方案生成异常（第 ${attempt + 1} 次）:`, e)
    }
  }
  return null
}

// ── 我的模式：真实证据装配（防幻觉，数字必须有出处） ─────────

/** DNA 取权重最高的若干条，转成"标签 count/sampleCount 篇"的真实陈述 */
function topDnaLines(items: DnaItem[], sampleCount: number, n: number): string[] {
  return [...items]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, n)
    .filter((it) => it.count > 0)
    .map((it) => `${it.label} ${it.count}/${sampleCount} 篇`)
}

export interface PlanEvidence {
  /** 注入 prompt 的真实证据清单文本；无任何数据时为空串 */
  text: string
  /** 用户历史作品总数（用于身份声明的真实引用数） */
  worksCount: number
}

/**
 * 从风格卡报告（creator_report）+ 真实计数 + 近期旧作装配证据清单。
 * 纯函数（不读库）；报告缺失时只保留可引用的近期主题，不产生任何统计句式。
 */
export function buildPlanEvidence(input: {
  report: unknown
  worksCount: number
  recentTopics: string[]
}): PlanEvidence {
  const report: CreatorReport | null = parseCreatorReport(input.report)
  const facts: string[] = []

  facts.push(`历史作品总数：${input.worksCount} 篇`)

  if (report && report.sampleCount > 0) {
    const n = report.sampleCount
    const motif = topDnaLines(report.motifDna, n, 3)
    const narrative = topDnaLines(report.narrativeDna, n, 2)
    const form = topDnaLines(report.formDna, n, 2)
    if (motif.length) facts.push(`母题偏好：${motif.join('；')}`)
    if (narrative.length) facts.push(`叙事切入：${narrative.join('；')}`)
    if (form.length) facts.push(`内容形式：${form.join('；')}`)
    if (report.languageDna?.pace) facts.push(`语言节奏：${report.languageDna.pace}`)
  }

  const topics = input.recentTopics.map((t) => `《${t.slice(0, 40)}》`).slice(0, 8)
  if (topics.length) facts.push(`近期作品主题：${topics.join('、')}`)

  // 只有总数、没有任何可解释素材时不输出清单（personal_reason 将只能为空）
  if (facts.length <= 1 && topics.length === 0) {
    return { text: '', worksCount: input.worksCount }
  }

  const rules = report
    ? '（personal_reason 只能引用以上事实与数字）'
    : '（无 DNA 统计时，personal_reason 只允许引用"近期作品主题"原名，禁止出现任何篇数或比例；不足以写出个性化理由时输出空串）'

  return {
    text: `【个性化推荐的真实证据清单${rules}】\n${facts.join('\n')}`,
    worksCount: input.worksCount,
  }
}
