// ============================================================
// 创作蓝图（Creative Blueprint）—— 前后端共享
// 阶段 2：AI 先产出蓝图（方向/结构/情绪/Hook…），用户在结果页可见，
//         确认（默认自动）后再依据蓝图生成 V1 正文。
// 问题分析层：ProblemUnderstanding（问题理解）挂载在蓝图超集上，
//         随 FrozenPlan → generation_history.blueprint jsonb 落库。
// 纯类型 + 纯函数 + 服务端 LLM 调用，前端只 import 类型与展示工具。
// ============================================================

/** 创作蓝图：一次生成的"方向层"产物（8 维 + 结构 + 策略 + 叙述人格） */
export interface CreativeBlueprint {
  title_direction: string // 标题方向
  positioning: string // 主题定位（切入角度）
  target_audience: string // 目标观众
  structure: string[] // 叙事结构（4-6 个段落步骤）
  emotion_curve: string // 情绪曲线
  opening_hook: string // 开头 Hook
  core_conflict: string // 核心冲突
  ending: string // 结尾价值升华
  strategy: string // 推荐创作策略
  persona_hint: string // 建议叙述人格
}

/** 蓝图生成的输入参数（由生成表单参数映射而来） */
export interface BlueprintInput {
  topic: string
  identityLabel: string
  identity: string // 身份模板的完整描述
  style: string
  category: string // 实际归类（含自定义品类文本）
  wordCount: number
  // 前端聚合的历史风格记忆（与 prompt-optimizer 同源）
  memory?: {
    identities: string
    styles: string
    categories: string
    favoredExcerpts: string
  }
  // 服务端查到的风格卡文本（由 API 层传入；游客为空）
  styleProfileText?: string
}

/** 问题理解：AI 对"用户想解决什么问题"的结构化拆解（问题分析层核心产物） */
export interface ProblemUnderstanding {
  problem_type: string // 问题类型，如"内容创作问题""商业规划问题""学习规划问题"
  is_content_creation: boolean // 是否属于文案创作类（决定前端生成按钮形态）
  user_goal: string // 用户真实目标（为什么需要它）
  task_breakdown: string[] // 要解决的核心子任务（3-6 条）
  user_identity: string // 用户身份推断与所需表达方式
  recommended_role: string // 最优 AI 角色（完整角色设定句，非标签）
  role_reason: string // 推荐该角色的原因
  success_criteria: string // 成功标准（可验证）
  professional_prompt: string // 完整自然语言专业 Prompt（可直接复制给任何大模型）
  /**
   * 阶段 3：使用场景（来自用户澄清）
   * 如"小红书""公众号""抖音"，影响内容风格和结构选择
   * 可选字段：老数据没有这个字段时为 undefined
   */
  scenario?: string
}

/** 问题理解兜底清洗：类型/目标/拆解三要素缺失即视为无效，调用方静默降级 */
export function normalizeProblem(raw: unknown): ProblemUnderstanding | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const s = (v: unknown, max: number): string =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''

  const tasks = Array.isArray(o.task_breakdown)
    ? o.task_breakdown
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter(Boolean)
        .slice(0, 6)
    : []

  const p: ProblemUnderstanding = {
    problem_type: s(o.problem_type, 60),
    is_content_creation: o.is_content_creation === true,
    user_goal: s(o.user_goal, 200),
    task_breakdown: tasks,
    user_identity: s(o.user_identity, 200),
    recommended_role: s(o.recommended_role, 200),
    role_reason: s(o.role_reason, 200),
    success_criteria: s(o.success_criteria, 200),
    professional_prompt: s(o.professional_prompt, 1500),
    // 阶段 3：scenario 可选字段，有值才挂
    ...(s(o.scenario, 100) ? { scenario: s(o.scenario, 100) } : {}),
  }
  if (!p.problem_type || !p.user_goal || p.task_breakdown.length === 0) return null
  return p
}

/** 把问题理解格式化为注入 LLM 的文本块（随蓝图一起注入生成调用） */
export function formatProblemForPrompt(pu: ProblemUnderstanding): string {
  const lines: string[] = [
    `问题类型：${pu.problem_type}`,
    `用户真实目标：${pu.user_goal}`,
  ]
  if (pu.scenario) lines.push(`使用场景：${pu.scenario}（内容风格需适配此场景）`)
  if (pu.task_breakdown.length > 0) {
    lines.push('需要解决的核心任务：')
    lines.push(...pu.task_breakdown.map((t, i) => `  ${i + 1}. ${t}`))
  }
  if (pu.user_identity) lines.push(`用户身份：${pu.user_identity}`)
  if (pu.recommended_role) lines.push(`AI 应扮演的角色：${pu.recommended_role}`)
  if (pu.success_criteria) lines.push(`成功标准：${pu.success_criteria}`)
  return `【问题理解（用户的真实目标，优先于文案技巧）】\n${lines.join('\n')}`
}

/** 字段兜底：LLM 偶发漏字段时保证前端展示不崩 */
export function normalizeBlueprint(raw: unknown): CreativeBlueprint | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const s = (v: unknown, max = 500): string =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''

  const arr = (v: unknown): string[] => {
    if (!Array.isArray(v)) return []
    return v
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter(Boolean)
      .slice(0, 6)
  }

  // 阶段 C：保留方案超集字段（content_type / language_style / word_count），
  // 旧字段缺失时按原逻辑兜底，新字段有值才保留。
  const lsRaw = o.language_style
  const language_style =
    lsRaw && typeof lsRaw === 'object'
      ? {
          pace: typeof (lsRaw as Record<string, unknown>).pace === 'string' ? ((lsRaw as Record<string, unknown>).pace as string).slice(0, 100) : undefined,
          mood: typeof (lsRaw as Record<string, unknown>).mood === 'string' ? ((lsRaw as Record<string, unknown>).mood as string).slice(0, 100) : undefined,
          expression: typeof (lsRaw as Record<string, unknown>).expression === 'string' ? ((lsRaw as Record<string, unknown>).expression as string).slice(0, 100) : undefined,
        }
      : undefined
  const hasLanguageStyle = language_style && (language_style.pace || language_style.mood || language_style.expression)

  const bp: CreativeBlueprint & {
    content_type?: string
    language_style?: { pace?: string; mood?: string; expression?: string }
    word_count?: number
    problem_understanding?: ProblemUnderstanding
    /** 阶段 3：跨设备恢复用的澄清回答原始值 */
    clarifications?: import('./intentClarity').ClarificationAnswer[]
    /** 市场约束：正文生成的硬约束（避开同质化、瞄准内容缺口） */
    market_constraints?: {
      avoid_points: string[]
      target_gaps: string[]
      strategy_action: 'reference' | 'upgrade' | 'avoid'
      strategy_reason: string
    }
  } = {
    title_direction: s(o.title_direction),
    positioning: s(o.positioning),
    target_audience: s(o.target_audience),
    structure: arr(o.structure),
    emotion_curve: s(o.emotion_curve),
    opening_hook: s(o.opening_hook),
    core_conflict: s(o.core_conflict),
    ending: s(o.ending),
    strategy: s(o.strategy),
    persona_hint: s(o.persona_hint),
  }

  // 超集字段：有值才挂上去
  const contentType = s(o.content_type)
  if (contentType) bp.content_type = contentType
  if (hasLanguageStyle) bp.language_style = language_style
  const wc = Number(o.word_count)
  if (Number.isFinite(wc) && wc > 0) bp.word_count = Math.min(Math.floor(wc), 5000)

  // 问题理解（问题分析层）：有值才挂上，缺失不阻塞原有蓝图功能
  const problem = normalizeProblem(o.problem_understanding)
  if (problem) bp.problem_understanding = problem

  // 阶段 3：澄清回答（跨设备恢复用）。有值才挂，缺失不阻塞原有功能
  const clarifications =
    Array.isArray(o.clarifications) && o.clarifications.length > 0
      ? (o.clarifications as Record<string, unknown>[])
          .map((c) => {
            const dim = s(c.dimension, 20)
            const ans = s(c.answer, 200)
            if (!dim || !ans) return null
            return { dimension: dim as 'goal' | 'audience' | 'scenario' | 'identity' | 'criteria', answer: ans }
          })
          .filter((c): c is { dimension: 'goal' | 'audience' | 'scenario' | 'identity' | 'criteria'; answer: string } => c !== null)
      : []
  if (clarifications.length > 0) bp.clarifications = clarifications

  // 市场约束：有值才挂上，缺失不阻塞原有蓝图功能
  const mcRaw = o.market_constraints
  if (mcRaw && typeof mcRaw === 'object') {
    const mc = mcRaw as Record<string, unknown>
    const avoid = Array.isArray(mc.avoid_points)
      ? mc.avoid_points
          .map((x) => (typeof x === 'string' ? x.trim().slice(0, 150) : ''))
          .filter(Boolean)
          .slice(0, 4)
      : []
    const gaps = Array.isArray(mc.target_gaps)
      ? mc.target_gaps
          .map((x) => (typeof x === 'string' ? x.trim().slice(0, 150) : ''))
          .filter(Boolean)
          .slice(0, 4)
      : []
    const actionRaw = typeof mc.strategy_action === 'string' ? mc.strategy_action.trim() : ''
    const reason = typeof mc.strategy_reason === 'string' ? mc.strategy_reason.trim().slice(0, 300) : ''
    if (avoid.length > 0 && (actionRaw === 'reference' || actionRaw === 'upgrade' || actionRaw === 'avoid') && reason) {
      bp.market_constraints = {
        avoid_points: avoid,
        target_gaps: gaps,
        strategy_action: actionRaw,
        strategy_reason: reason,
      }
    }
  }

  // 至少要有主题定位或标题方向，否则视为无效蓝图
  if (!bp.title_direction && !bp.positioning) return null
  return bp
}

/**
 * 调用 DeepSeek 生成创作蓝图（强制 JSON 输出）。
 * 仅服务端使用（依赖 DEEPSEEK_API_KEY）。
 * 失败返回 null，调用方降级为"无蓝图直接生成"，不阻断主流程。
 */
export async function generateBlueprint(
  input: BlueprintInput
): Promise<CreativeBlueprint | null> {
  const mem = input.memory
  const structureRequirement =
    input.wordCount >= 600
      ? '5-6 个段落'
      : input.wordCount >= 300
        ? '4-5 个段落'
        : '3-4 个段落'

  const system = [
    '你是资深短视频内容策划总监，擅长为解说类内容设计高完播率的叙事蓝图。',
    '你的任务：根据用户给出的主题、创作者身份、内容品类和风格条件，产出一份结构化"创作蓝图"。',
    '硬性要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    '2. 所有字符串字段使用中文；structure 为字符串数组；',
    '3. 蓝图要具体、可执行，禁止"引人入胜""精彩绝伦"这类空话，Hook 要给出具体写法或示例；',
    '4. JSON 必须严格包含以下 key：',
    'title_direction, positioning, target_audience, structure, emotion_curve, opening_hook, core_conflict, ending, strategy, persona_hint',
  ].join('\n')

  const user = `请为以下创作任务设计蓝图：

解说主题：${input.topic}
创作者身份：${input.identityLabel}（${input.identity}）
文风要求：${input.style || '由身份自然决定'}
内容品类：${input.category}
目标字数：${input.wordCount} 字（叙事结构安排 ${structureRequirement}）
${input.styleProfileText ?? ''}${mem
    ? `
【用户历史风格记忆（仅微调参考，本次指令优先）】
历史高频身份：${mem.identities || '暂无'}
历史常用文风：${mem.styles || '暂无'}
常用品类：${mem.categories || '暂无'}
收藏范文语言特征：${mem.favoredExcerpts || '暂无收藏范文'}`
    : ''}

各字段含义：
- title_direction：一句话标题/立意方向（10-25 字）
- positioning：主题定位，说明本篇的独特切入角度（一句话）
- target_audience：目标观众画像（一句话）
- structure：叙事结构数组，按顺序给出每个段落的任务（如"Hook：用悬念场景开场"）
- emotion_curve：情绪曲线设计，说明情绪如何起伏递进（一句话）
- opening_hook：开头 3 秒 Hook 的具体写法或示例句
- core_conflict：全篇核心冲突/核心张力（一句话）
- ending：结尾价值升华或互动引导（一句话）
- strategy：针对该品类的推荐创作策略（一句话）
- persona_hint：建议的叙述人格（如"冷静的真相揭露者""孤独叙事者"）`

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
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.5,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      console.error('创作蓝图生成失败:', await res.text())
      return null
    }
    const data = await res.json()
    const text: string = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) return null

    // 防御：个别情况下模型仍可能包一层 ```json
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const parsed: unknown = JSON.parse(cleaned)
    return normalizeBlueprint(parsed)
  } catch (e) {
    console.error('创作蓝图生成异常:', e)
    return null
  }
}

/**
 * 把蓝图格式化为注入 LLM prompt 的文本段（两次正文生成共用）。
 * 前端也可用它做纯展示，但展示场景建议直接用字段卡片。
 * 阶段 C：兼容方案超集（content_type/language_style），有值才渲染。
 * 市场约束：随 FrozenPlan 注入，作为正文生成的硬约束（避开同质化、瞄准内容缺口）。
 */
export function formatBlueprintForPrompt(
  bp: CreativeBlueprint & {
    content_type?: string
    language_style?: { pace?: string; mood?: string; expression?: string }
    problem_understanding?: ProblemUnderstanding
    market_constraints?: {
      avoid_points: string[]
      target_gaps: string[]
      strategy_action: 'reference' | 'upgrade' | 'avoid'
      strategy_reason: string
    }
  }
): string {
  const lines: string[] = [
    `标题方向：${bp.title_direction}`,
    `主题定位：${bp.positioning}`,
  ]
  if (bp.content_type) lines.push(`内容类型：${bp.content_type}`)
  if (bp.target_audience) lines.push(`目标观众：${bp.target_audience}`)
  lines.push(`叙事结构：`)
  lines.push(...bp.structure.map((step, i) => `  ${i + 1}. ${step}`))
  if (bp.emotion_curve) lines.push(`情绪曲线：${bp.emotion_curve}`)
  if (bp.opening_hook) lines.push(`开头 Hook：${bp.opening_hook}`)
  if (bp.core_conflict) lines.push(`核心冲突：${bp.core_conflict}`)
  if (bp.ending) lines.push(`结尾升华：${bp.ending}`)
  if (bp.strategy) lines.push(`创作策略：${bp.strategy}`)
  lines.push(`创作视角：${bp.persona_hint}`)
  if (bp.language_style) {
    const ls = [bp.language_style.pace, bp.language_style.mood, bp.language_style.expression]
      .filter(Boolean)
      .join(' · ')
    if (ls) lines.push(`语言风格：${ls}`)
  }
  // 问题理解块：用户的真实目标优先于文案技巧，随蓝图一起注入生成调用
  if (bp.problem_understanding) {
    lines.push('', formatProblemForPrompt(bp.problem_understanding))
  }
  // 市场硬约束：正文必须避开同质化角度、尽量覆盖内容缺口
  if (bp.market_constraints) {
    const mc = bp.market_constraints
    const actionLabel: Record<string, string> = {
      reference: '借鉴成熟结构',
      upgrade: '升级已有角度',
      avoid: '红海建议换角度',
    }
    lines.push(
      '',
      `【市场硬约束（正文必须遵守）】`,
      `推荐策略：${actionLabel[mc.strategy_action] ?? mc.strategy_action}（${mc.strategy_reason}）`,
      '必须避开的同质化角度（正文不得出现这些表达/切入）：',
      ...mc.avoid_points.map((p) => `- ${p}`),
    )
    if (mc.target_gaps.length > 0) {
      lines.push('应尽量覆盖的内容缺口（正文至少命中 1 个）：')
      lines.push(...mc.target_gaps.map((g) => `- ${g}`))
    }
  }
  return `【已确认的创作方案（本次创作必须严格遵循）】\n${lines.join('\n')}`
}
