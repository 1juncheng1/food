// ============================================================
// Inspiration Analyzer —— AI 灵感分析与转化系统
//
// 设计原则：
//   1. 不生成"3 个创作方向"（避免与现有 generatePlan 重复）
//   2. 只做"灵感价值评估 + 优化建议"——是 generatePlan 的前置增量
//   3. 禁止无脑赞美：低质量灵感必须明确指出问题
//   4. 素材召回复用 scripts.knowledge + match_scripts RPC，无外部 API
//   5. 一次 LLM 调用产出完整 InspirationAnalysis；失败返回 null 降级
//
// 依赖说明：仅从 ./marketAnalyzer 引类型（单向依赖，无环）；
// marketAnalyzer 不引用本文件。
//
// 与 generatePlan 的边界：
//   - inspirationAnalyzer：判断"这个灵感值不值得做 + 怎么优化"
//   - generatePlan：在灵感值得做后，产出"3 个差异化方向 + 完整方案"
//   前端在 insight 态用户确认后，把 analysis 文本注入 plan prompt。
// ============================================================

import { callDeepSeekChat, llmTimeoutMs, stripJsonFence } from '@/lib/llm'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MarketReport } from './marketAnalyzer'
import { formatMarketForPrompt, normalizeMarketReport } from './marketAnalyzer'

/** 灵感输入类型（LLM 自动判断） */
export type InspirationInputType =
  | 'title' // 标题
  | 'sentence' // 一句话想法
  | 'news' // 新闻
  | 'material' // 素材
  | 'random_thought' // 随机念头
  | 'video_summary' // 视频链接摘要
  | 'other'

/**
 * 内容领域分类（仅用于数据沉淀与未来个性化推荐，不在 UI 上展示为标签）。
 * 驱动价值：统计用户偏好领域 → 个性化灵感推荐 → Creator Profile 主题偏好学习。
 * 不驱动：当前一次创作决策（plan 生成不依赖此字段）。
 */
export type ContentDomain =
  | 'tech' // 科技
  | 'business' // 商业
  | 'society' // 社会
  | 'lifestyle' // 生活方式
  | 'education' // 教育
  | 'culture' // 文化
  | 'personal_growth' // 个人成长
  | 'other'

/** 灵感价值评估（8 维度，全部必填） */
export interface ValueAssessment {
  what_it_is: string // AI 描述这个灵感是什么
  core_theme: string // 核心主题（一句话）
  content_domain: ContentDomain // 内容领域分类（数据沉淀用，不展示为标签）
  creation_value: string // 创作价值分析（一句话，可指出价值低）
  freshness: string // 新鲜度：是否已有大量类似内容
  discussability: string // 讨论价值
  differentiation: string // 差异化程度
  competition_level: number // 竞争激烈程度 1-10 整数（1=蓝海 10=红海）
  competition_reason: string // 竞争度打分依据（一句话，必须解释为什么是这个分；强制 LLM 自我审视）
  overall_score: number // 1-10 整数；<5 时 issues 必须非空
  issues: string[] // 具体问题清单；低质量灵感必填
}

/**
 * 机会矩阵象限：overall_score × competition_level 组合判断。
 * 前端展示用，不落库（由两个分数实时计算）。
 */
// 机会象限是纯推导函数，已抽到 ./opportunity（零运行时依赖），
// 以便 'use client' 组件直接引用而不必加载本文件（含 DeepSeek 调用）。
// 此处再导出以保持既有调用方不变。
export { getOpportunityQuadrant } from './opportunity'
export type { OpportunityQuadrant } from './opportunity'

/** 优化建议 */
export interface OptimizationSuggestions {
  main_problem: string // 当前最大的问题（一句话）
  missing_info: string[] // 缺少什么信息
  missing_viewpoints: string[] // 缺少什么观点
  improvement_direction: string // 如何提升吸引力
  /**
   * 本阶段最优解：按 improvement_direction 改写出的、可以直接拿去创作的
   * 具体题目/角度（一句话）。用户点「基于这个灵感开始创作」时作为创作主题。
   * 旧数据无此字段时为 '' —— 调用方回退到原始灵感，不阻断流程。
   */
  optimized_topic: string
}

/** 一次灵感分析的完整结果（落 inspiration_context jsonb） */
export interface InspirationAnalysis {
  raw_input: string // 原始输入
  input_type: InspirationInputType
  value_assessment: ValueAssessment
  optimization_suggestions: OptimizationSuggestions
  /** 召回的相关素材 ID（仅登录用户有值） */
  recalled_material_ids: string[]
  /** 市场格局分析（可选二级深挖动作产出；见 marketAnalyzer.ts） */
  market_report?: MarketReport
  analyzed_at: string // ISO
}

// ── 兜底清洗 ────────────────────────────────────────────────

function s(v: unknown, max: number): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''
}

function strArr(v: unknown, maxLen: number, itemMax: number): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    if (typeof x === 'string' && x.trim()) {
      out.push(x.trim().slice(0, itemMax))
      if (out.length >= maxLen) break
    }
  }
  return out
}

const INPUT_TYPES: readonly InspirationInputType[] = [
  'title', 'sentence', 'news', 'material', 'random_thought', 'video_summary', 'other',
]

function normalizeInputType(v: unknown): InspirationInputType {
  const t = typeof v === 'string' ? v.trim() : ''
  return (INPUT_TYPES as readonly string[]).includes(t) ? (t as InspirationInputType) : 'other'
}

const CONTENT_DOMAINS: readonly ContentDomain[] = [
  'tech', 'business', 'society', 'lifestyle', 'education', 'culture', 'personal_growth', 'other',
]

function normalizeContentDomain(v: unknown): ContentDomain {
  const d = typeof v === 'string' ? v.trim() : ''
  return (CONTENT_DOMAINS as readonly string[]).includes(d) ? (d as ContentDomain) : 'other'
}

function normalizeValueAssessment(raw: unknown): ValueAssessment | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const what_it_is = s(o.what_it_is, 300)
  const core_theme = s(o.core_theme, 100)
  const creation_value = s(o.creation_value, 300)
  const freshness = s(o.freshness, 200)
  const discussability = s(o.discussability, 200)
  const differentiation = s(o.differentiation, 200)

  // 6 个文字维全部必填（缺一视为无效，调用方降级）
  if (!what_it_is || !core_theme || !creation_value || !freshness || !discussability || !differentiation) {
    return null
  }

  let overall_score = 5
  const rawScore = Number(o.overall_score)
  if (Number.isFinite(rawScore)) {
    overall_score = Math.max(1, Math.min(10, Math.round(rawScore)))
  }

  let competition_level = 5
  const rawCompetition = Number(o.competition_level)
  if (Number.isFinite(rawCompetition)) {
    competition_level = Math.max(1, Math.min(10, Math.round(rawCompetition)))
  }

  // 强制 competition_reason（一句话解释，缺则视为无效，降级）
  const competition_reason = s(o.competition_reason, 200)
  if (!competition_reason) return null

  const issues = strArr(o.issues, 5, 200)
  // 硬约束：低分必须有 issues，否则补一条（防 LLM 漏字段）
  if (overall_score < 5 && issues.length === 0) {
    issues.push('灵感质量偏低，需要更具体的切入角度或差异化信息')
  }

  return {
    what_it_is, core_theme,
    content_domain: normalizeContentDomain(o.content_domain),
    creation_value, freshness,
    discussability, differentiation,
    competition_level, competition_reason, overall_score, issues,
  }
}

function normalizeOptimization(raw: unknown): OptimizationSuggestions | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const main_problem = s(o.main_problem, 300)
  const improvement_direction = s(o.improvement_direction, 300)
  // 两条核心字段必填（missing_info/viewpoints 允许空但需有数组形式）
  if (!main_problem || !improvement_direction) return null
  return {
    main_problem,
    missing_info: strArr(o.missing_info, 5, 200),
    missing_viewpoints: strArr(o.missing_viewpoints, 5, 200),
    improvement_direction,
    // 最优解允许缺省（历史数据兼容）；缺失时前端回退到原始灵感
    optimized_topic: s(o.optimized_topic, 120),
  }
}

/** 兜底清洗 LLM 输出。无效返回 null，调用方降级。 */
export function normalizeInspirationAnalysis(raw: unknown): InspirationAnalysis | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const value = normalizeValueAssessment(o.value_assessment)
  const optimization = normalizeOptimization(o.optimization_suggestions)
  if (!value || !optimization) return null

  const raw_input = s(o.raw_input, 2000)
  if (!raw_input) return null

  // 市场报告（可选）：清洗后保留，不合规直接丢弃（宁缺毋假）
  const marketReport = normalizeMarketReport(o.market_report)

  return {
    raw_input,
    input_type: normalizeInputType(o.input_type),
    value_assessment: value,
    optimization_suggestions: optimization,
    recalled_material_ids: strArr(o.recalled_material_ids, 10, 100),
    ...(marketReport ? { market_report: marketReport } : {}),
    analyzed_at: s(o.analyzed_at, 40) || new Date().toISOString(),
  }
}

// ── 服务端：素材召回（复用 match_scripts RPC）─────────────

export interface RecallMaterial {
  id: string
  content: string
  similarity: number
}

/**
 * 向量检索用户素材库 Top N（仅登录用户、仅 knowledge.confidence>=0.6 的素材参与）。
 * 使用 match_scripts RPC（p_usage_filter=null 时纯向量检索，老素材 knowledge=null 不受影响）。
 */
export async function recallMaterials(
  supabase: ReturnType<typeof import('@/lib/supabaseServer').createServerClient>,
  userId: string,
  embedding: number[],
  matchCount = 3
): Promise<RecallMaterial[]> {
  if (!embedding || embedding.length === 0) return []
  try {
    const { data, error } = await supabase.rpc('match_scripts', {
      query_embedding: embedding,
      match_count: matchCount,
      p_user_id: userId,
      p_usage_filter: null,
    })
    if (error) {
      console.error('素材召回失败:', error.message)
      return []
    }
    if (!Array.isArray(data)) return []
    return data
      .filter((r: { id?: unknown; content?: unknown; similarity?: unknown }) =>
        typeof r.id === 'string' && typeof r.content === 'string'
      )
      .map((r: { id: string; content: string; similarity: number }) => ({
        id: r.id,
        content: r.content.slice(0, 400),
        similarity: typeof r.similarity === 'number' ? r.similarity : 0,
      }))
  } catch (e) {
    console.error('素材召回异常:', e)
    return []
  }
}

// ── 服务端：分析 Prompt ────────────────────────────────────

const ANALYSIS_JSON_KEYS = [
  'input_type',
  'value_assessment',
  'optimization_suggestions',
].join(', ')

function buildSystemPrompt(): string {
  return [
    '你是资深内容选题评估专家。用户给你一个不完整的灵感（可能是标题、一句话、新闻、素材、随机念头、视频摘要），你的任务是做客观、不奉承的价值评估。',
    '',
    '硬性原则（重点）：',
    '1. 禁止无脑赞美。低质量灵感必须明确指出问题。禁止"很有潜力""值得挖掘""这是个好方向"这类空话。',
    '2. 如果灵感方向比较普通、已有大量类似内容，必须直接说明："这个方向目前比较普通，已有大量类似内容，建议改变切入角度"。',
    '3. overall_score 必须 1-10 整数；< 5 时 issues 数组必须非空且包含至少 1 条具体问题。',
    '4. 所有文本字段使用中文，口语化直接，不空泛。',
    '',
    'input_type 枚举（自动识别）：',
    '- title：单个标题（如"AI会不会取代程序员"）',
    '- sentence：一句话想法（如"如果人类能上传意识会怎样"）',
    '- news：新闻/资讯类输入',
    '- material：素材/案例原文',
    '- random_thought：随机念头/随笔',
    '- video_summary：视频链接/摘要',
    '- other：以上都不贴合',
    '',
    'value_assessment 9 维度说明：',
    '- what_it_is：用一句话客观描述这个灵感是什么',
    '- core_theme：核心主题（10-30 字）',
    '- content_domain：内容领域分类，从枚举中选 1 个（' + CONTENT_DOMAINS.join(' / ') + '）',
    '- creation_value：值不值得做成内容（一句话，可指出价值低）',
    '- freshness：新鲜度，是否已有大量类似内容；若是老话题要点名',
    '- discussability：是否有人会讨论/转发/争论',
    '- differentiation：当前切入角度是否差异化；若无差异化点要指出',
    '- competition_level：竞争激烈程度 1-10 整数',
    '- competition_reason：竞争度打分依据（一句话，必须解释为什么是这个分）',
    '- overall_score：综合创作价值 1-10 整数（与竞争度独立评估，高分不一定低竞争）',
    '- issues：具体问题清单（数组）；低分必填，可写多条',
    '',
    '【关键】competition_level 判定准则——判断的是"这个具体切入角度"的竞争度，不是整个话题的竞争度：',
    '  1分：几乎没有主流平台报道过这个具体角度（例：脑机接口审美的哲学含义）',
    '  2分：极少数小众讨论，未形成话题（例：意识上传后的产权归属）',
    '  3分：零星报道，但未形成内容品类（例：远程办公对程序员职业身份认同的影响）',
    '  4分：少量同类内容，但用户还记不住"又来一篇"（例：用 AI 做个人知识库的具体方法）',
    '  5分：中等热度，主流平台偶尔出现（例：Notion vs Obsidian 选型）',
    '  6分：有一定讨论，但未饱和（例：程序员副业选择）',
    '  7分：已被多平台反复讨论，用户开始疲劳（例：35 岁程序员危机）',
    '  8分：热门话题，每周都有大量同类内容（例：AI 编程助手横评）',
    '  9分：极度饱和，用户看到标题就划走（例：内卷话题）',
    '  10分：已被做烂，几乎无新增量空间（例：996 批判、"AI 取代程序员"提问式标题）',
    '',
    '【关键】competition_reason 必须与 competition_level 一致：',
    '  - 给 2 分时，reason 必须说明"这个角度少见"',
    '  - 给 8 分时，reason 必须说明"已被反复讨论"',
    '  - 禁止出现 reason 说"少见/有新意"但 competition_level 给 6+ 的自相矛盾',
    '',
    '【关键】competition_level 与 differentiation 必须自洽：',
    '  - differentiation 写"少见""罕见""新意""独特"时，competition_level 必须 ≤ 4',
    '  - differentiation 写"无差异化""同质化""常见"时，competition_level 必须 ≥ 7',
    '',
    'competition_level 与 overall_score 的区别：',
    '- overall_score 高 + competition_level 低 = 蓝海机会（值得做）',
    '- overall_score 高 + competition_level 高 = 红海但值得做（需差异化）',
    '- overall_score 低 + competition_level 高 = 不建议做',
    '- competition_level 看的是"这个切入角度已有多少人在做"，不是看内容质量',
    '',
    'optimization_suggestions 5 字段：',
    '- main_problem：当前最大的问题（一句话，如"切入点过于常见，无差异化"）',
    '- missing_info：缺什么信息（数组，2-4 条，如"缺少具体数据""缺少反例"）',
    '- missing_viewpoints：缺什么观点（数组，2-4 条，如"缺少用户视角""缺少反对意见"）',
    '- improvement_direction：如何提升吸引力（一句话，具体可执行）',
    '- optimized_topic：本阶段最优解——按 improvement_direction 的改法，把原灵感改写成一句可以直接拿去创作的具体题目/角度',
    '    （15-40 字，必须含"对象 + 切入角度 + 冲突/悬念"，如"我给相亲对象做了份 SWOT 分析，结果自己出局了"）；',
    '    禁止空话（"一个更值得写的角度"），禁止写成建议；用户点「基于这个灵感开始创作」时会直接用它当创作主题。',
    '',
    '【few-shot 校准样本】（覆盖科技/职场/情感/商业领域，参考这些标注来给分）：',
    '示例1：',
    '  输入："AI会不会取代程序员"',
    '  → competition_level: 10',
    '  → competition_reason: "提问式标题已被 ChatGPT 爆火至今海量报道，几乎每周都有同类内容"',
    '  → overall_score: 4',
    '  → differentiation: "当前标题没有任何差异化角度，纯提问式"',
    '示例2：',
    '  输入："意识上传后，我的产权归谁"',
    '  → competition_level: 2',
    '  → competition_reason: "意识上传本身有讨论，但产权归属这个法律角度几乎没主流报道过"',
    '  → overall_score: 7',
    '  → differentiation: "从法律/产权角度切入比单纯讨论意识身份有显著新意"',
    '示例3：',
    '  输入："用 AI 帮我整理 Obsidian 笔记"',
    '  → competition_level: 5',
    '  → competition_reason: "AI+知识管理有中等热度讨论，但具体到 Obsidian 工作流的少"',
    '  → overall_score: 6',
    '  → differentiation: "工具组合具体，但角度不算新颖，已有类似教程"',
    '示例4：',
    '  输入："30岁转行还来得及吗"',
    '  → competition_level: 8',
    '  → competition_reason: "职场转型焦虑是常青热门选题，30岁节点被各平台反复消费"',
    '  → overall_score: 4',
    '  → differentiation: "纯提问式且无行业限定，与海量同类转行内容同质化"',
    '示例5：',
    '  输入："我给相亲对象做了个SWOT分析"',
    '  → competition_level: 3',
    '  → competition_reason: "相亲情感内容量大，但用商业分析框架制造反差的角度鲜有人做"',
    '  → overall_score: 7',
    '  → differentiation: "理性框架与感性场景的反差自带记忆点和故事性"',
    '示例6：',
    '  输入："某新能源品牌宣布全系降价3万"（新闻类输入）',
    '  → competition_level: 6',
    '  → competition_reason: "车企降价是财经区常规题材，当天必有一波解读，热度中高"',
    '  → overall_score: 6',
    '  → differentiation: "单纯跟进降价解读的角度已经很多，但价格战背后的供应链成本视角提供了额外分析维度"',
    '',
    '硬性输出要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    '2. JSON 必须严格包含以下 key：',
    `   ${ANALYSIS_JSON_KEYS}`,
    '   value_assessment 必须包含：what_it_is, core_theme, content_domain, creation_value, freshness, discussability, differentiation, competition_level, competition_reason, overall_score, issues；',
    '   optimization_suggestions 必须包含：main_problem, missing_info, missing_viewpoints, improvement_direction, optimized_topic；',
    '3. 不输出 raw_input（由服务端补回）、不输出 recalled_material_ids（由服务端补回）。',
  ].join('\n')
}

function buildUserPrompt(rawInput: string): string {
  return [
    '请分析以下用户灵感输入：',
    '',
    '---',
    rawInput.slice(0, 2000),
    '---',
    '',
    '按规则输出 JSON。',
  ].join('\n')
}

/**
 * 调用 DeepSeek 生成灵感分析。失败返回 null，调用方降级。
 *
 * billing 传了才计费（「预扣 → 按真实用量结算 → 失败全退」）；
 * 不传则行为与改造前一致（仅供内部/离线调用）。
 */
export async function analyzeInspiration(
  rawInput: string,
  billing?: { supabase: SupabaseClient; userId: string; refId?: string }
): Promise<{
  input_type: InspirationInputType
  value_assessment: ValueAssessment
  optimization_suggestions: OptimizationSuggestions
} | null> {
  // 缺 optimized_topic 的分析先暂存：优先重试让 LLM 补齐本阶段最优解
  let withoutOptimalTopic: {
    input_type: InspirationInputType
    value_assessment: ValueAssessment
    optimization_suggestions: OptimizationSuggestions
  } | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await callDeepSeekChat({
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserPrompt(rawInput) },
        ],
        temperature: 0.4,
        max_tokens: 1500,
        jsonMode: true,
        timeoutMs: llmTimeoutMs(1500),
        // 计费：3 次尝试各用各的 refId——复用会让第 2 次起被判重复预扣（reserved=0）
        ...(billing
          ? {
              billing: {
                supabase: billing.supabase,
                userId: billing.userId,
                ability: 'diagnosis' as const,
                refId: `${billing.refId ?? crypto.randomUUID()}:inspiration:${attempt}`,
                description: '灵感分析',
              },
            }
          : {}),
      })

      if (!res.ok) {
        // 余额不足不会走到这里：预扣失败在发起 HTTP 前就返回了，一个 token 都没花
        console.error('灵感分析失败:', res.error)
        return null
      }
      const parsed = JSON.parse(stripJsonFence(res.content))

      const value = normalizeValueAssessment(parsed?.value_assessment)
      const optimization = normalizeOptimization(parsed?.optimization_suggestions)
      if (!value || !optimization) continue

      const result = {
        input_type: normalizeInputType(parsed?.input_type),
        value_assessment: value,
        optimization_suggestions: optimization,
      }
      if (optimization.optimized_topic) return result
      // 分析有效但缺最优解：暂存后重试，全部失败再降级返回它
      withoutOptimalTopic = result
    } catch (e) {
      console.error(`灵感分析异常（第 ${attempt + 1} 次）:`, e)
    }
  }
  return withoutOptimalTopic
}

// ── 把 analysis 格式化为注入 plan prompt 的文本块 ────────

/**
 * 把 InspirationAnalysis 格式化为可注入 generatePlan prompt 的文本块。
 * 让 plan 阶段的 LLM 看到"这个灵感是什么、缺什么、要补什么"，
 * 使得 3 个方向与方案能延续灵感分析阶段发现的问题与改进方向。
 */
export function formatInspirationForPrompt(a: InspirationAnalysis): string {
  const v = a.value_assessment
  const o = a.optimization_suggestions
  const lines: string[] = [
    '【灵感分析阶段结论（本次 plan 必须延续这些判断）】',
    `原始灵感：${a.raw_input.slice(0, 200)}`,
    `灵感类型：${a.input_type}`,
    `内容领域：${v.content_domain}`,
    '',
    '价值评估：',
    `- 是什么：${v.what_it_is}`,
    `- 核心主题：${v.core_theme}`,
    `- 创作价值：${v.creation_value}`,
    `- 新鲜度：${v.freshness}`,
    `- 讨论度：${v.discussability}`,
    `- 差异化：${v.differentiation}`,
    `- 竞争激烈程度：${v.competition_level}/10（${v.competition_reason}）`,
    `- 综合评分：${v.overall_score}/10`,
  ]
  if (v.issues.length > 0) {
    lines.push(`- 已识别问题：${v.issues.join('；')}`)
  }
  lines.push('', '优化建议：')
  lines.push(`- 最大问题：${o.main_problem}`)
  if (o.missing_info.length) lines.push(`- 缺少信息：${o.missing_info.join('；')}`)
  if (o.missing_viewpoints.length) lines.push(`- 缺少观点：${o.missing_viewpoints.join('；')}`)
  lines.push(`- 提升方向：${o.improvement_direction}`)
  if (o.optimized_topic) {
    lines.push(
      '',
      `【本次采用的创作主题（灵感阶段最优解）】${o.optimized_topic}`,
      '上面的 topic 就是这个最优解；三个方向必须围绕它展开，不要退回原始灵感。'
    )
  }

  // 市场格局分析（可选二级深挖产出）
  if (a.market_report) {
    const m = a.market_report
    lines.push('')
    lines.push(formatMarketForPrompt(m))
    lines.push('请在 3 个方向中至少 1 个方向瞄准"内容缺口"；所有方向避开"同质化重复点"。')
    if (m.recommended_topic) {
      lines.push(
        `本次采用的创作主题是该市场的"本阶段最优解"：${m.recommended_topic}`,
        '三个方向必须围绕它展开，不要退回原始灵感。'
      )
    }
  } else {
    lines.push('')
    lines.push('请在 3 个方向的差异化设计、content_type_reason、opening_hook 中体现上述分析与建议；禁止与已识别问题重复的方向切入。')
  }
  return lines.join('\n')
}
