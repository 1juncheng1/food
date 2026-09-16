// ============================================================
// Intent Clarity Engine（意图澄清引擎）—— 阶段 1
//
// 在 /api/creative/plan 单入口中先调用，判定用户主题是否需要澄清。
// 与现有 generatePlan 完全解耦：本模块只产"问题"，不产"方案"。
// 用户回答后由 plan API 把 clarifications 注入 generatePlan 的 user prompt。
//
// 设计原则：
//   1. 动态 0-3 个问题：已隐含维度不问，模糊维度才问，上限 3
//   2. 选择式问题：每问 2-4 个具体选项 + 允许自定义，禁止开放式提问
//   3. 优先级排序：goal > audience > scenario > identity > criteria
//      （影响最终结果最大的因素优先问）
//   4. 不问字数/标题/排版/字号等参数：交给 AI 自动优化
//
// 纯类型 + 纯函数 + 服务端 LLM 调用，前端只 import 类型。
// ============================================================

/** 澄清维度：5 个关键信息缺口（按对最终结果影响从大到小排序） */
export type ClarificationDimension =
  | 'goal' // 用户目标：为什么需要这个内容
  | 'audience' // 目标受众：内容面对谁
  | 'scenario' // 使用场景：准备在哪里使用
  | 'identity' // 用户身份：用户是谁，决定表达口吻
  | 'criteria' // 评价标准：怎样算成功

// ── 常量与基础工具（供 normalize* 函数共用） ───────────────────

const DIMENSIONS: readonly ClarificationDimension[] = [
  'goal',
  'audience',
  'scenario',
  'identity',
  'criteria',
]

const DIMENSION_SET = new Set<string>(DIMENSIONS)

function s(v: unknown, max: number): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''
}

/** 一个选择式澄清问题 */
export interface ClarificationQuestion {
  /** 与 dimension 同值，前端用作 question_id */
  id: string
  dimension: ClarificationDimension
  /** 选择式问题文本，口语化直接，如"你希望这个内容达到什么目的？" */
  question: string
  /** 2-4 个具体可感知的选项 */
  options: string[]
  /** 是否允许自定义输入（默认 true） */
  allowCustom: boolean
}

/** 意图清晰度判定结果 */
export interface IntentClarityResult {
  /** 是否需要澄清（gaps 非空即 true） */
  needs_clarification: boolean
  /** 缺失维度列表（按优先级排序） */
  gaps: ClarificationDimension[]
  /** 最多 3 个问题，按优先级取 gaps 前 3 生成 */
  questions: ClarificationQuestion[]
  /** AI 推断的已有信息（用户可见，用于"我已理解"反馈） */
  inferred: {
    goal?: string
    audience?: string
    scenario?: string
    identity?: string
    criteria?: string
  }
  /** 向用户解释为什么要问（0 问题时为空串） */
  reason: string
}

/**
 * 用户对澄清问题的回答（阶段 2 前端 → API → plan.ts）。
 * answer 为选项值或自定义文本；dimension 与 ClarificationQuestion.dimension 同值。
 */
export interface ClarificationAnswer {
  dimension: ClarificationDimension
  answer: string
}

/**
 * 服务端重校验客户端提交的澄清回答。
 * - dimension 必须合法
 * - answer 去空白、限长 200、非空
 * - 同一 dimension 重复出现的以最后一条为准
 * 与项目"绝不信任客户端原始 JSON"原则一致。
 */
export function normalizeClarifications(
  raw: unknown
): ClarificationAnswer[] {
  if (!Array.isArray(raw)) return []
  const out: ClarificationAnswer[] = []
  const seen = new Map<string, number>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const dim = s(o.dimension, 20)
    if (!DIMENSION_SET.has(dim)) continue
    const ans = s(o.answer, 200)
    if (!ans) continue
    const idx = seen.get(dim)
    if (idx === undefined) {
      seen.set(dim, out.length)
      out.push({ dimension: dim as ClarificationDimension, answer: ans })
    } else {
      // 后者覆盖前者（同一维度多次回答时取最后一次）
      out[idx] = { dimension: dim as ClarificationDimension, answer: ans }
    }
  }
  return out
}

// ── 兜底清洗 ────────────────────────────────────────────────

/**
 * 清洗单个问题对象。
 * 无效返回 null：缺少必填字段、options 不足 2 个、dimension 非法。
 */
function normalizeQuestion(raw: unknown): ClarificationQuestion | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const dimension = s(o.dimension, 20)
  if (!DIMENSION_SET.has(dimension)) return null
  const dim = dimension as ClarificationDimension

  const question = s(o.question, 200)
  if (!question) return null

  const options = Array.isArray(o.options)
    ? o.options
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter(Boolean)
        .slice(0, 4)
    : []
  // 不足 2 个选项的选择式问题没有意义，视为无效
  if (options.length < 2) return null

  return {
    id: dim, // dimension 本身就是稳定 id
    dimension: dim,
    question,
    options,
    allowCustom: o.allowCustom !== false, // 默认允许自定义
  }
}

/**
 * 兜底清洗 LLM 输出。
 * 无效返回 null：调用方降级为"不澄清直接进 plan 生成"，不阻断主流程。
 *
 * 一致性校验：以 questions 实际内容为准修正 needs_clarification，
 * 避免 LLM 输出 needs_clarification=true 但 questions 为空的矛盾态。
 */
export function normalizeIntentClarity(raw: unknown): IntentClarityResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  // gaps 清洗：保留合法维度，去重保序
  const gapsRaw = Array.isArray(o.gaps) ? o.gaps : []
  const seen = new Set<string>()
  const gaps: ClarificationDimension[] = []
  for (const g of gapsRaw) {
    if (typeof g === 'string' && DIMENSION_SET.has(g) && !seen.has(g)) {
      seen.add(g)
      gaps.push(g as ClarificationDimension)
    }
  }

  // questions 清洗：过滤无效项，最多保留 3 个
  const questionsRaw = Array.isArray(o.questions) ? o.questions : []
  const questions: ClarificationQuestion[] = []
  for (const q of questionsRaw) {
    if (questions.length >= 3) break
    const nq = normalizeQuestion(q)
    if (nq) questions.push(nq)
  }

  // inferred 清洗：每个维度保留非空字符串
  const inferredRaw =
    typeof o.inferred === 'object' && o.inferred !== null
      ? (o.inferred as Record<string, unknown>)
      : {}
  const inferred: IntentClarityResult['inferred'] = {}
  for (const dim of DIMENSIONS) {
    const val = s(inferredRaw[dim], 200)
    if (val) inferred[dim] = val
  }

  const reason = s(o.reason, 300)

  // 一致性：以 questions 实际情况决定 needs_clarification
  // LLM 可能输出 needs=true 但 questions 为空（矛盾），按真实可展示内容修正
  const needs = questions.length > 0

  // questions 中的 dimension 必须出现在 gaps 中（否则补进 gaps）
  // 这一步保证 gaps 是 questions 维度的并集，前端展示一致
  for (const q of questions) {
    if (!seen.has(q.dimension)) {
      seen.add(q.dimension)
      gaps.push(q.dimension)
    }
  }

  return {
    needs_clarification: needs,
    gaps,
    questions,
    inferred,
    reason: needs ? reason : '',
  }
}

// ── 服务端：判定 Prompt ─────────────────────────────────

/** 判定调用的服务端输入（与 generatePlan 解耦，不注入风格卡/DNA） */
export interface JudgeIntentInput {
  topic: string
}

const CLARITY_JSON_KEYS = [
  'needs_clarification',
  'gaps',
  'questions',
  'inferred',
  'reason',
].join(', ')

function buildClaritySystemPrompt(): string {
  return [
    '你是用户意图分析专家。用户给出一个主题后，判断 5 个关键维度的信息是否已隐含在主题里，只对缺失且影响最终结果的维度生成选择式澄清问题。',
    '',
    '5 个维度（按"对最终结果影响"从大到小排序）：',
    '1. goal：用户目标——为什么需要这个内容（如获得流量/建立个人品牌/商业转化/知识分享/融资/求职）',
    '2. audience：目标受众——内容面对谁（如创业者/家长/学生/同行专家/投资人/老板）',
    '3. scenario：使用场景——准备在哪里发布（如小红书/公众号/抖音/B站/知乎/内部汇报/融资路演）',
    '4. identity：用户身份——用户是谁，决定表达口吻（如创业者/老师/研究者/学生/产品经理）',
    '5. criteria：评价标准——怎样算成功（如10w阅读/投资人认可/学生懂了/品牌曝光/对方同意）',
    '',
    '隐含识别规则（重点！以下情况视为该维度已明确，不能生成问题）：',
    '',
    '【goal 隐含信号】出现任何一个 → goal 已明确：',
    '- 直接说目标："目标是X""目的是X""为了X""要X""拿到X""获得X""实现X"',
    '- 主题本身就是工具/载体："商业计划书""项目方案""产品介绍"→ goal 隐含为融资/展示/说服',
    '- 主题带明确导向："写XX来吸引投资人""做XX涨粉""用XX求职"',
    '- 动作词暗示目标："推广""营销""引流""说服""打动"',
    '',
    '【audience 隐含信号】出现任何一个 → audience 已明确：',
    '- 直接说受众："给XX看""面向XX""XX必读""写给XX"',
    '- 主题本身限定受众："儿童科普""高考作文""AI教程给产品经理"',
    '- 使用场景暗示受众："融资路演""内部汇报""公开课"',
    '',
    '【scenario 隐含信号】出现任何一个 → scenario 已明确：',
    '- 直接说平台："小红书""公众号""抖音""B站""知乎""视频号""微博"',
    '- 主题带平台风格词："小红书风""抖音短平快""公众号深度长文"',
    '- 使用场景暗示："朋友圈文案""发布会演讲稿""融资路演PPT"',
    '',
    '【identity/objective 隐含规则】',
    '- 主题中说"我是XX""作为XX""以XX身份"→ identity 已明确',
    '- 评价标准通常不需要主动澄清——除非用户主题里完全没有目标和场景',
    '',
    '判定规则：',
    '- 主题中已隐含的维度（包括按上面规则识别的隐含信号），必须输出到 inferred 对象，不能为该维度生成问题；',
    '- 只有真正缺失且影响结果的维度才生成问题；',
    '- 宁可少问，不要让用户被烦——一个完整的主题请求（如"写一份AI创业商业计划书，目标是融资"）通常只需要 0-1 个问题；',
    '- 最多生成 3 个问题，按上面优先级排序取前 3；',
    '- 缺失维度为 0 个时，needs_clarification=false，questions=[]，reason=""。',
    '',
    '问题形式硬约束：',
    '- 必须是选择式：给出 2-4 个具体可选答案；',
    '- 禁止开放式问题，禁止"请输入你的需求"式提问；',
    '- 禁止询问字数、标题格式、排版、字号等可由 AI 自动优化的参数；',
    '- 选项必须具体可感知（如"获得流量"而非"流量方向"）；',
    '- question 文本要口语化、直接，如"你希望这个内容达到什么目的？"。',
    '',
    '硬性输出要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    '2. 所有字符串字段使用中文；',
    '3. JSON 必须严格包含以下 key：',
    CLARITY_JSON_KEYS,
    '   gaps 的元素只能从 goal/audience/scenario/identity/criteria 中取；',
    '   questions 每项必须包含：id（与 dimension 同值）, dimension, question, options（2-4 个字符串）, allowCustom；',
    '   inferred 的键为上述 5 维度名，值为推断文本；未推断的维度不出现该键；',
    '   reason 一句话向用户解释为什么要问这些问题（0 问题时为空串）。',
  ].join('\n')
}

function buildClarityUserPrompt(input: JudgeIntentInput): string {
  // 前端/平台关键词信号检测（简单字符串匹配，辅助 AI 识别隐含维度）
  const t = input.topic.toLowerCase()
  const detected: string[] = []
  // scenario 信号
  if (/小红书/.test(input.topic)) detected.push('scenario=小红书')
  if (/公众号|微信公众号/.test(input.topic)) detected.push('scenario=公众号')
  if (/抖音|tiktok/.test(input.topic)) detected.push('scenario=抖音')
  if (/b站|bilibili/.test(input.topic)) detected.push('scenario=B站')
  if (/知乎/.test(input.topic)) detected.push('scenario=知乎')
  if (/视频号/.test(input.topic)) detected.push('scenario=视频号')
  if (/微博/.test(input.topic)) detected.push('scenario=微博')
  if (/融资路演|路演ppt/.test(input.topic)) detected.push('scenario=融资路演')
  if (/内部汇报|汇报ppt/.test(input.topic)) detected.push('scenario=内部汇报')
  // goal 信号
  if (/目标是|目的是|为了|拿到|获得|实现/.test(input.topic)) detected.push('goal=有明确目标词')
  if (/涨粉|吸粉|引流|获客/.test(input.topic)) detected.push('goal=获取流量/涨粉')
  if (/融资|天使轮|a轮|ipo/.test(t)) detected.push('goal=融资')
  if (/求职|找工作|面试/.test(input.topic)) detected.push('goal=求职')
  if (/推广|营销|说服|打动/.test(input.topic)) detected.push('goal=商业转化')
  if (/商业计划书|bp|项目方案/.test(t)) detected.push('goal=融资/展示/说服（商业计划书类隐含）')
  // audience 信号
  if (/写给|面向|给.*看|.*必读/.test(input.topic)) detected.push('audience=有明确受众词')
  if (/家长|父母|亲子/.test(input.topic)) detected.push('audience=家长群体')
  if (/学生|高考|考研|学习/.test(input.topic)) detected.push('audience=学生群体')
  if (/投资人|投资方|vc/.test(t)) detected.push('audience=投资人')
  if (/老板|领导|管理层/.test(input.topic)) detected.push('audience=管理层')

  return [
    '请分析以下用户主题，判断需要澄清哪些维度：',
    '',
    `用户主题：${input.topic}`,
    '',
    detected.length > 0
      ? `【自动检测到的关键词信号（参考）】\n${detected.map((d) => `- ${d}`).join('\n')}\n注意：这些信号只是辅助，最终判断以主题整体语义为准。`
      : '【自动检测】未检测到明显的平台/目标/受众关键词信号。',
    '',
    '输出 JSON（needs_clarification=false 且 questions=[] 表示信息足够，直接生成方案）。',
  ].join('\n')
}

/**
 * 启发式预检查：不调 LLM，直接用关键词信号判断主题是否"足够明确"。
 * 命中 → 直接返回 needs_clarification=false 跳过判定（省一次 LLM 调用 + 更稳定）。
 * 未命中 → 继续走 LLM 判定（让 AI 处理边界情况）。
 *
 * 判定规则：
 *   - 目标/载体信号 + 平台/场景信号 ≥ 2 个 → 跳过
 *   - 主题长度 ≥ 15 且包含至少一个目标词 → 跳过
 *   - 主题本身是一个完整请求（有明确动作+对象+目的）→ 跳过
 *
 * 故意保守：宁可多问不要跳过需要澄清的模糊主题。
 */
function heuristicPreCheck(topic: string): IntentClarityResult | null {
  const signals: ClarificationDimension[] = []
  const inferred: Partial<Record<ClarificationDimension, string>> = {}

  // goal 信号
  if (/目标是|目的是|为了|拿到|获得|实现/.test(topic)) {
    signals.push('goal')
    inferred.goal = '主题含明确目标词'
  }
  if (/涨粉|吸粉|引流|获客/.test(topic)) {
    signals.push('goal')
    inferred.goal = '获取流量/涨粉'
  }
  if (/融资|天使轮|a轮|ipo/.test(topic.toLowerCase())) {
    signals.push('goal')
    inferred.goal = '融资'
  }
  if (/求职|找工作|面试/.test(topic)) {
    signals.push('goal')
    inferred.goal = '求职'
  }
  if (/商业计划书|bp|项目方案/.test(topic.toLowerCase())) {
    signals.push('goal')
    inferred.goal = '融资/展示/说服（商业计划书类隐含）'
  }

  // scenario 信号
  if (/小红书/.test(topic)) { signals.push('scenario'); inferred.scenario = '小红书' }
  if (/公众号|微信公众号/.test(topic)) { signals.push('scenario'); inferred.scenario = '公众号' }
  if (/抖音|tiktok/.test(topic.toLowerCase())) { signals.push('scenario'); inferred.scenario = '抖音' }
  if (/b站|bilibili/.test(topic.toLowerCase())) { signals.push('scenario'); inferred.scenario = 'B站' }
  if (/知乎/.test(topic)) { signals.push('scenario'); inferred.scenario = '知乎' }
  if (/视频号/.test(topic)) { signals.push('scenario'); inferred.scenario = '视频号' }
  if (/融资路演|路演ppt/.test(topic)) { signals.push('scenario'); inferred.scenario = '融资路演' }
  if (/内部汇报|汇报ppt/.test(topic)) { signals.push('scenario'); inferred.scenario = '内部汇报' }

  // audience 信号
  if (/写给|面向|给.*看|.*必读/.test(topic)) {
    signals.push('audience')
    inferred.audience = '主题含明确受众词'
  }
  if (/家长|父母|亲子/.test(topic)) { signals.push('audience'); inferred.audience = '家长群体' }
  if (/学生|高考|考研|学习/.test(topic)) { signals.push('audience'); inferred.audience = '学生群体' }
  if (/投资人|投资方|\bvc\b/.test(topic.toLowerCase())) { signals.push('audience'); inferred.audience = '投资人' }
  if (/老板|领导|管理层/.test(topic)) { signals.push('audience'); inferred.audience = '管理层' }

  // 决策规则（按优先级）：
  // 1. ≥ 2 个不同维度的信号 → 明确
  // 2. goal 维度有 ≥ 2 个信号（同维度多次命中）→ 明确
  //    如"商业计划书 + 融资"虽然都是 goal，但组合起来足够明确
  // 3. ≥ 1 个维度信号 + 主题长度 ≥ 20 + 有动作词 → 明确
  const uniqueDims = new Set(signals)
  const dimCounts: Record<string, number> = {}
  for (const d of signals) dimCounts[d] = (dimCounts[d] ?? 0) + 1

  if (uniqueDims.size >= 2) {
    return { needs_clarification: false, gaps: [], questions: [], inferred, reason: '' }
  }
  if ((dimCounts['goal'] ?? 0) >= 2) {
    return { needs_clarification: false, gaps: [], questions: [], inferred, reason: '' }
  }
  if (uniqueDims.size >= 1 && topic.length >= 20 && /写|做|帮我|制作|生成|产出/.test(topic)) {
    return { needs_clarification: false, gaps: [], questions: [], inferred, reason: '' }
  }

  return null // 启发式无法判断，交给 LLM
}

/**
 * 调用 DeepSeek 判定用户意图清晰度（强制 JSON 输出）。
 * 仅服务端使用；失败返回 null，调用方降级为"不澄清直接进 plan 生成"。
 *
 * 温度 0.3：判定层需要稳定性，避免同一主题反复给出不同问题集。
 * max_tokens 800：判定输出远短于方案生成，节省成本。
 */
export async function judgeIntentClarity(
  input: JudgeIntentInput
): Promise<IntentClarityResult | null> {
  // ── 启发式预检查：命中则跳过 LLM 调用（更快、更稳、更省成本）──
  const heuristic = heuristicPreCheck(input.topic)
  if (heuristic) return heuristic

  // ── LLM 判定：处理启发式无法覆盖的边界情况 ──
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
            { role: 'system', content: buildClaritySystemPrompt() },
            { role: 'user', content: buildClarityUserPrompt(input) },
          ],
          temperature: 0.3,
          max_tokens: 800,
          response_format: { type: 'json_object' },
        }),
      })

      if (!res.ok) {
        console.error('意图清晰度判定失败:', await res.text())
        return null
      }
      const data = await res.json()
      const text: string = data?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim()) return null

      // 防御：个别情况下模型仍可能包一层 ```json
      const cleaned = text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
      const parsed = normalizeIntentClarity(JSON.parse(cleaned))
      if (parsed) return parsed
      // normalize 返回 null 说明字段不全，重试
    } catch (e) {
      console.error(`意图清晰度判定异常（第 ${attempt + 1} 次）:`, e)
    }
  }
  return null
}
