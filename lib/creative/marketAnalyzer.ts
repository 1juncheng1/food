// ============================================================
// marketAnalyzer —— 内容市场分析引擎（Content Market Intelligence）
//
// 定位：回答"市场上长什么样、哪里有空"，与 inspirationAnalyzer 的
// "值不值得做"（打分）互补，是其二级深挖动作（消费 competition_reason 作种子）。
//
// 数据来源分层（Provider 接口不绑定平台）：
//   MVP  ：LLMEstimateProvider —— DeepSeek 基于训练知识做"模式级"估算
//   中期 ：WebSearchProvider   —— Tavily/Bing 等聚合搜索 → 真实结果提取
//   长期 ：PlatformProvider    —— 抖音/B站/知乎适配器（按资质与合规逐个接）
//
// 核心红线：反幻觉。LLM 估算模式下只允许"模式级"结论，
// 禁止编造具体标题/数据/创作者名（详见 buildSystemPrompt）。
// ============================================================

import { llmTimeoutSignal } from '@/lib/llm'

// ── 类型 ────────────────────────────────────────────────────

/** 数据来源模式：落库 + 前端展示免责标注的依据 */
export type MarketDataSourceMode = 'llm_estimate' | 'web_search'

/** 推荐策略：参考 / 升级 / 避开 */
export type MarketStrategyAction = 'reference' | 'upgrade' | 'avoid'

/** 热门内容方向（模式级，非具体作品） */
export interface HotDirection {
  pattern: string // 热门标题/内容结构模式（如"提问式""数字盘点式"）
  why: string // 为什么有效（心理机制）
}

/** 推荐策略 */
export interface MarketStrategy {
  action: MarketStrategyAction
  reason: string
}

/** 一次市场分析的完整结果（落 inspiration_context.market_report） */
export interface MarketReport {
  data_source_mode: MarketDataSourceMode
  heat_level: number // 市场热度 1-10
  market_heat: string // 市场热度一句话
  hot_directions: HotDirection[] // 热门内容方向 2-4 条
  audience_motivation: string // 用户为什么关注/评论/讨论
  mainstream_expression: string // 当前主流表达方式
  homogenization_points: string[] // 同质化重复点 2-4 条
  content_gaps: string[] // 内容缺口 2-4 条（核心价值）
  competition_risks: string[] // 竞争风险 1-3 条
  strategy: MarketStrategy // 推荐策略
  generated_at: string // ISO
}

/** 市场分析输入 */
export interface MarketAnalysisInput {
  raw_input: string
  /** 灵感分析阶段的竞争度判断，作为估算种子（可缺省） */
  competition_level?: number
  competition_reason?: string
  content_domain?: string
}

/**
 * 市场数据 Provider 接口层——未来接新数据源时实现此接口即可，
 * 调用方（API route / 页面）无需改动。
 */
export interface MarketDataProvider {
  readonly mode: MarketDataSourceMode
  analyze(input: MarketAnalysisInput): Promise<MarketReport | null>
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

const STRATEGY_ACTIONS: readonly MarketStrategyAction[] = ['reference', 'upgrade', 'avoid']

/** 兜底清洗市场报告。核心字段缺失/非法返回 null，调用方降级。 */
export function normalizeMarketReport(raw: unknown): MarketReport | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const market_heat = s(o.market_heat, 200)
  const audience_motivation = s(o.audience_motivation, 300)
  const mainstream_expression = s(o.mainstream_expression, 300)
  if (!market_heat || !audience_motivation || !mainstream_expression) return null

  let heat_level = 5
  const rawHeat = Number(o.heat_level)
  if (Number.isFinite(rawHeat)) {
    heat_level = Math.max(1, Math.min(10, Math.round(rawHeat)))
  }

  // 热门方向：pattern + why 均必填
  const hot_directions: HotDirection[] = []
  if (Array.isArray(o.hot_directions)) {
    for (const d of o.hot_directions) {
      if (typeof d !== 'object' || d === null) continue
      const dd = d as Record<string, unknown>
      const pattern = s(dd.pattern, 150)
      const why = s(dd.why, 200)
      if (pattern && why) {
        hot_directions.push({ pattern, why })
        if (hot_directions.length >= 4) break
      }
    }
  }
  if (hot_directions.length === 0) return null

  const homogenization_points = strArr(o.homogenization_points, 4, 150)
  const content_gaps = strArr(o.content_gaps, 4, 150)
  const competition_risks = strArr(o.competition_risks, 3, 150)
  // 核心价值字段：同质化/缺口/风险任一为空即视为无效
  if (!homogenization_points.length || !content_gaps.length || !competition_risks.length) {
    return null
  }

  // 策略：action 必须是合法枚举 + reason 必填
  const st = (typeof o.strategy === 'object' && o.strategy !== null ? o.strategy : {}) as Record<string, unknown>
  const action = s(st.action, 20) as MarketStrategyAction
  const reason = s(st.reason, 300)
  if (!(STRATEGY_ACTIONS as readonly string[]).includes(action) || !reason) return null

  return {
    data_source_mode: 'llm_estimate',
    heat_level,
    market_heat,
    hot_directions,
    audience_motivation,
    mainstream_expression,
    homogenization_points,
    content_gaps,
    competition_risks,
    strategy: { action, reason },
    generated_at: new Date().toISOString(),
  }
}

// ── Prompt（反幻觉硬约束）───────────────────────────────────

const MARKET_JSON_KEYS =
  '{ data_source_mode, heat_level, market_heat, hot_directions: [{pattern, why}], audience_motivation, mainstream_expression, homogenization_points, content_gaps, competition_risks, strategy: {action, reason} }'

function buildSystemPrompt(): string {
  return [
    '你是资深内容市场分析师。用户给你一个创作主题，以及此前"灵感价值分析"给出的竞争度判断作为参考种子。',
    '你基于对主流内容平台（公众号/小红书/抖音/B站/知乎等）内容生态的认知，分析这个主题的市场格局，帮助创作者发现创作机会。',
    '目标不是复制热门内容，而是找到市场空白。',
    '',
    '【核心红线——反幻觉约束（最高优先级，违反任何一条即为无效输出）】',
    '1. 你没有实时数据。所有结论必须是你训练知识中对"内容生态模式"的总结。禁止编造：',
    '   - 禁止声称某个具体的视频/文章/标题真实存在并引用它（可以说"常见的标题结构是…"，不能说"爆款《XXX》就是…"）',
    '   - 禁止输出具体的播放量、点赞数、评论数、粉丝数、发布日期',
    '   - 禁止提及任何真实创作者/账号名作为案例',
    '2. 只允许"模式级"结论：标题结构模式（如提问式/数字盘点式/反转式）、表达方式、用户心理动机、同质化模式、空白角度。',
    '3. 禁止精确统计口径（如"80%的内容都…"），用"多数""不少""普遍"等保守表述。',
    '4. 如果主题太新或太小众、你没有可靠认知，如实降低 heat_level 并在 market_heat 中说明"该方向内容样本少，判断仅供参考"，禁止硬编。',
    '',
    '字段说明：',
    '- heat_level：市场热度 1-10 整数。锚点：1-2 冷门几乎没有内容生态；3-4 有零星内容；5-6 中等热度稳定产出；7-8 高热度大量同类；9-10 饱和刷屏。热度看"内容供给量"，与质量无关',
    '- market_heat：热度一句话说明（含依据）',
    '- hot_directions：热门内容方向，2-4 条。pattern 写标题/内容结构模式（不引用具体作品），why 写心理机制',
    '- audience_motivation：用户为什么关注、为什么评论、为什么产生讨论（一句话，写真实动机）',
    '- mainstream_expression：当前主流表达方式（一句话，如"段子化吐槽+金句收尾"）',
    '- homogenization_points：当前市场大量内容都在重复的点，2-4 条（每条一句话）',
    '- content_gaps：没有被满足的角度/缺口，2-4 条。这是本分析的核心价值：必须是可切入的具体角度，不是空话',
    '- competition_risks：竞争风险，1-3 条（如"头部账号已占领心智""话题疲劳"）',
    '- strategy.action：推荐策略，三选一：',
    '    reference = 市场有成熟结构可借鉴（用不同素材/角度填充）',
    '    upgrade = 已有角度可升级（更深/更具体/反常识）',
    '    avoid = 当前角度已是红海，建议换角度',
    '- strategy.reason：推荐原因（一句话，与 content_gaps 呼应）',
    '',
    '硬性输出要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    `2. JSON 必须严格包含以下 key：${MARKET_JSON_KEYS}`,
    '3. 不输出 data_source_mode（由服务端补回）、不输出 generated_at（由服务端补回）。',
  ].join('\n')
}

function buildUserPrompt(input: MarketAnalysisInput): string {
  const lines: string[] = [
    '请分析以下创作主题的市场格局：',
    '',
    '---',
    input.raw_input.slice(0, 2000),
    '---',
  ]
  const seeds: string[] = []
  if (typeof input.competition_level === 'number') {
    seeds.push(`灵感分析给出的竞争度：${input.competition_level}/10`)
  }
  if (input.competition_reason) {
    seeds.push(`竞争度判断依据：${input.competition_reason}`)
  }
  if (input.content_domain) {
    seeds.push(`内容领域：${input.content_domain}`)
  }
  if (seeds.length) {
    lines.push('', '参考种子（来自灵感分析，请保持一致，不要矛盾）：', ...seeds.map((x) => `- ${x}`))
  }
  lines.push('', '按规则输出 JSON。')
  return lines.join('\n')
}

// ── LLM 估算 Provider（MVP）─────────────────────────────────

/** DeepSeek 估算 Provider：基于训练知识做模式级市场分析 */
const llmEstimateProvider: MarketDataProvider = {
  mode: 'llm_estimate',
  async analyze(input: MarketAnalysisInput): Promise<MarketReport | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            'Content-Type': 'application/json',
          },
          signal: llmTimeoutSignal(1800),
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: buildSystemPrompt() },
              { role: 'user', content: buildUserPrompt(input) },
            ],
            temperature: 0.5,
            max_tokens: 1800,
            response_format: { type: 'json_object' },
          }),
        })

        if (!res.ok) {
          console.error('市场分析失败:', await res.text())
          return null
        }
        const data = await res.json()
        const text: string = data?.choices?.[0]?.message?.content
        if (typeof text !== 'string' || !text.trim()) return null

        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        const parsed = JSON.parse(cleaned)
        const report = normalizeMarketReport(parsed)
        if (report) return report
        // 清洗失败（LLM 漏字段），重试
      } catch (e) {
        console.error(`市场分析异常（第 ${attempt + 1} 次）:`, e)
      }
    }
    return null
  },
}

// ── Web Search Provider（真实数据模式，P0 数据层接入）────────

/**
 * 基于真实搜索结果的提取式市场分析（CI 数据层消费方）。
 *
 * 与估算模式的本质区别：结论从真实网页/新闻条目中"提取"，
 * 而非从训练知识"估算"——幻觉面大幅收窄，但仍有两条红线：
 *   1. 禁止引用条目清单之外的具体作品/数据
 *   2. 指标字段为 null（web/news 源无互动数据）时禁止编造数字
 *
 * 降级策略：数据层不可用（无 key）/搜索失败/条目为空 → 回退估算 Provider，
 * 返回的 report.data_source_mode 自动变回 llm_estimate（UI 徽章如实降级）。
 */
const webSearchProvider: MarketDataProvider = {
  mode: 'web_search',
  async analyze(input: MarketAnalysisInput): Promise<MarketReport | null> {
    const { ciSearch } = await import('../ci/service')
    const result = await ciSearch({
      topic: input.raw_input,
      content_domain: input.content_domain,
      maxItems: 10,
    })

    // 数据层不可用或无条目：回退估算（报告模式自动诚实标注）
    if (result.noAdapters) {
      console.warn('CI 数据层未配置（缺 TAVILY_API_KEY），市场分析回退估算模式')
      return llmEstimateProvider.analyze(input)
    }
    if (result.items.length === 0) {
      console.warn('CI 搜索无结果，市场分析回退估算模式')
      return llmEstimateProvider.analyze(input)
    }

    // 组装真实条目摘要（只给 LLM 必要字段，控制 token）
    const itemLines = result.items.slice(0, 10).map((it, i) => {
      const ai = it.ai_analysis
      const metricsPart = it.metrics.play_count !== null ? `（播放 ${it.metrics.play_count}）` : ''
      const aiPart = ai
        ? `｜开头:${ai.opening_structure ?? '—'}｜观点:${ai.core_viewpoint ?? '—'}｜情绪:${ai.emotion_type ?? '—'}｜结构:${ai.narrative_structure ?? '—'}`
        : ''
      return `${i + 1}. [${it.platform}] ${it.title}${metricsPart}\n   摘要：${it.excerpt.slice(0, 200)}${aiPart}`
    })

    const seeds: string[] = []
    if (typeof input.competition_level === 'number') {
      seeds.push(`灵感分析给出的竞争度：${input.competition_level}/10`)
    }
    if (input.competition_reason) seeds.push(`竞争度判断依据：${input.competition_reason}`)
    if (input.content_domain) seeds.push(`内容领域：${input.content_domain}`)

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            'Content-Type': 'application/json',
          },
          signal: llmTimeoutSignal(1800),
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              {
                role: 'system',
                content: [
                  '你是资深内容市场分析师。下方是围绕用户创作主题搜索到的真实网页/新闻条目，你基于这些真实结果分析市场格局，帮助创作者发现创作机会（不是复制热门内容）。',
                  '',
                  '【核心红线（违反任何一条即为无效输出）】',
                  '1. 所有结论必须源自下方条目清单，禁止编造清单之外的具体作品、标题、数据、创作者名；',
                  '2. 条目没有提供互动数据（播放/点赞等）时，禁止编造任何数字——结论用模式级表述（"多数""普遍"）；',
                  '3. 禁止精确统计口径（如"80%的内容"），用保守表述。',
                  '',
                  '字段要求（与估算模式一致）：',
                  '- heat_level：市场热度 1-10 整数（基于真实结果的数量、时效性、话题覆盖面综合判断）',
                  '- market_heat：热度一句话（需点出依据来自搜索结果）',
                  '- hot_directions：热门内容方向 2-4 条，pattern 写标题/内容结构模式（从条目标题中归纳），why 写心理机制',
                  '- audience_motivation：用户为什么关注/评论/讨论（一句话）',
                  '- mainstream_expression：当前主流表达方式（一句话，从条目摘要归纳）',
                  '- homogenization_points：条目间重复的内容角度，2-4 条',
                  '- content_gaps：条目清单没覆盖、但目标受众关心的角度，2-4 条（核心价值）',
                  '- competition_risks：竞争风险 1-3 条',
                  '- strategy.action：reference（市场有成熟结构可借鉴）/ upgrade（已有角度可升级）/ avoid（当前角度是红海，建议换角度）',
                  '- strategy.reason：推荐原因一句话（与 content_gaps 呼应）',
                  '',
                  '硬性输出要求：只输出一个 JSON 对象，不要 markdown 代码块；',
                  `JSON 必须严格包含以下 key：${MARKET_JSON_KEYS}`,
                  '不输出 data_source_mode（由服务端补回）、不输出 generated_at（由服务端补回）。',
                ].join('\n'),
              },
              {
                role: 'user',
                content: [
                  `创作主题：${input.raw_input.slice(0, 500)}`,
                  seeds.length ? `参考种子（保持一致，不要矛盾）：\n${seeds.map((x) => `- ${x}`).join('\n')}` : '',
                  '真实搜索条目：',
                  ...itemLines,
                  '',
                  '按规则输出 JSON。',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            temperature: 0.4,
            max_tokens: 1800,
            response_format: { type: 'json_object' },
          }),
        })
        if (!res.ok) {
          console.error('市场分析（web_search 模式）失败:', await res.text())
          return null
        }
        const data = await res.json()
        const text: string = data?.choices?.[0]?.message?.content
        if (typeof text !== 'string' || !text.trim()) return null

        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        const parsed = JSON.parse(cleaned)
        const report = normalizeMarketReport(parsed)
        if (report) {
          report.data_source_mode = 'web_search' // 覆盖 normalize 的默认值，UI 徽章据此升级
          return report
        }
      } catch (e) {
        console.error(`市场分析异常（web_search 模式，第 ${attempt + 1} 次）:`, e)
      }
    }
    return null
  },
}

/**
 * 获取当前市场数据 Provider。
 * 有 TAVILY_API_KEY（CI 数据层可用）→ web_search 模式；否则估算模式。
 * 调用方无感——切换只改数据来源与免责标注，接口形态完全一致。
 */
export function getMarketProvider(): MarketDataProvider {
  if (process.env.TAVILY_API_KEY) {
    return webSearchProvider
  }
  return llmEstimateProvider
}

// ── 把 MarketReport 格式化为注入 plan prompt 的文本块 ───────

/** 把市场分析结论注入 plan 阶段：方向设计优先瞄准内容缺口、避开同质化重复点 */
export function formatMarketForPrompt(r: MarketReport): string {
  const lines: string[] = [
    '【市场格局分析（本次 plan 的方向设计必须参考）】',
    `市场热度：${r.heat_level}/10（${r.market_heat}）`,
    '热门内容方向（模式级）：',
    ...r.hot_directions.map((d) => `- ${d.pattern}（有效原因：${d.why}）`),
    `- 用户关注原因：${r.audience_motivation}`,
    `- 当前主流表达：${r.mainstream_expression}`,
    '同质化重复点（方向设计必须避开）：',
    ...r.homogenization_points.map((x) => `- ${x}`),
    '内容缺口（方向设计优先瞄准这些空白）：',
    ...r.content_gaps.map((x) => `- ${x}`),
    '竞争风险：',
    ...r.competition_risks.map((x) => `- ${x}`),
    `推荐策略：${r.strategy.action}（${r.strategy.reason}）`,
  ]
  return lines.join('\n')
}
