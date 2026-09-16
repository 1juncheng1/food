// ============================================================
// AI 作品诊断（Creative Diagnosis）—— 前后端共享
// 阶段 4：每次生成后自动从 5 个维度评估作品，输出优势 / 问题 /
//         可执行建议，并给出 6 类"下一步创作方向"。
// 评分刻意使用 1-5 的定性信号等级（突出/良好/中规中矩/偏弱/待提升），
// 不使用精确百分制，避免伪精确与"唯分数"误导。
// 纯类型 + 纯函数 + 服务端 LLM 调用，前端只 import 类型与元数据。
// ============================================================

import { formatBlueprintForPrompt, normalizeBlueprint, type CreativeBlueprint } from './blueprint'

// ── 五个诊断维度（顺序即展示顺序）──
export type DimensionKey =
  | 'opening' // 开头吸引力
  | 'structure' // 内容结构
  | 'emotion' // 情感强度
  | 'style_fit' // 风格匹配度
  | 'virality' // 传播潜力

export interface DiagnosisDimension {
  level: number // 1-5 定性等级（5=突出 4=良好 3=中规中矩 2=偏弱 1=待提升）
  comment: string // 结合文本的具体点评（一句，禁止空话）
}

// ── 下一步创作方向（6 类 AI 推荐 + 1 类用户自定义；固定 key）──
export type NextActionKey =
  | 'hit' // 爆款内容优化
  | 'style' // 风格强化
  | 'emotion' // 情感增强
  | 'depth' // 深度升级
  | 'video' // 短视频改编
  | 'script' // 脚本转换
  | 'custom' // 用户自定义修改（携带一句话指令；不由诊断 LLM 生成建议）

export interface CreativeDiagnosis {
  dimensions: Record<DimensionKey, DiagnosisDimension>
  strengths: string[] // 明确优势
  problems: string[] // 现存问题
  suggestions: string[] // 可执行的优化建议
  nextActions: Record<NextActionKey, string> // 每个方向一句"下一步具体怎么做"
  diagnosedAt: string // 诊断时间（ISO，服务端写入）
}

/** 维度展示元数据（前端共用） */
export const DIMENSION_META: Array<{
  key: DimensionKey
  label: string
  emoji: string
  hint: string
}> = [
  { key: 'opening', label: '开头吸引力', emoji: '🎣', hint: '前 3 秒能否抓住注意力' },
  { key: 'structure', label: '内容结构', emoji: '🧱', hint: '叙事节奏与逻辑递进' },
  { key: 'emotion', label: '情感强度', emoji: '💫', hint: '情绪起伏与共鸣感' },
  { key: 'style_fit', label: '风格匹配度', emoji: '🎭', hint: '与身份/文风要求的贴合' },
  { key: 'virality', label: '传播潜力', emoji: '📈', hint: '完播、互动与转发潜力' },
]

/** 定性等级文案（不展示数字分数） */
export const LEVEL_LABELS: Record<number, string> = {
  5: '突出',
  4: '良好',
  3: '中规中矩',
  2: '偏弱',
  1: '待提升',
}

/** 六类下一步方向展示元数据（前端共用） */
export const NEXT_ACTION_META: Array<{
  key: NextActionKey
  label: string
  emoji: string
  blurb: string
}> = [
  { key: 'hit', label: '爆款优化', emoji: '🔥', blurb: '围绕完播与转发重构记忆点' },
  { key: 'style', label: '风格强化', emoji: '🎭', blurb: '让叙述人格与语感更鲜明' },
  { key: 'emotion', label: '情感增强', emoji: '💞', blurb: '放大共鸣点与情绪张力' },
  { key: 'depth', label: '深度升级', emoji: '🧠', blurb: '补充信息密度与观点厚度' },
  { key: 'video', label: '短视频改编', emoji: '🎬', blurb: '改写为更短时长的镜头化版本' },
  { key: 'script', label: '脚本转换', emoji: '📝', blurb: '转成分镜/口播可执行脚本' },
]

function clampLevel(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 3
  return Math.max(1, Math.min(5, Math.round(n)))
}

function strList(v: unknown, max: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .slice(0, max)
    .map((s) => s.slice(0, maxLen))
}

/** 字段兜底：LLM 偶发漏字段 / 结构异常时保证前端展示不崩 */
export function normalizeDiagnosis(raw: unknown): Omit<CreativeDiagnosis, 'diagnosedAt'> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const rawDims =
    typeof o.dimensions === 'object' && o.dimensions !== null
      ? (o.dimensions as Record<string, unknown>)
      : {}

  const dimEntry = (key: DimensionKey): DiagnosisDimension => {
    const d =
      typeof rawDims[key] === 'object' && rawDims[key] !== null
        ? (rawDims[key] as Record<string, unknown>)
        : {}
    const comment =
      typeof d.comment === 'string' && d.comment.trim()
        ? d.comment.trim().slice(0, 300)
        : ''
    return { level: clampLevel(d.level), comment }
  }

  const rawActions =
    typeof o.next_actions === 'object' && o.next_actions !== null
      ? (o.next_actions as Record<string, unknown>)
      : {}
  const action = (key: NextActionKey): string =>
    typeof rawActions[key] === 'string'
      ? (rawActions[key] as string).trim().slice(0, 300)
      : ''

  const diagnosis: Omit<CreativeDiagnosis, 'diagnosedAt'> = {
    dimensions: {
      opening: dimEntry('opening'),
      structure: dimEntry('structure'),
      emotion: dimEntry('emotion'),
      style_fit: dimEntry('style_fit'),
      virality: dimEntry('virality'),
    },
    strengths: strList(o.strengths, 4, 300),
    problems: strList(o.problems, 4, 300),
    suggestions: strList(o.suggestions, 4, 300),
    nextActions: {
      hit: action('hit'),
      style: action('style'),
      emotion: action('emotion'),
      depth: action('depth'),
      video: action('video'),
      script: action('script'),
      // custom 不由诊断 LLM 输出，恒为空串（前端渲染自定义输入卡，不读该值）
      custom: '',
    },
  }

  // 至少要有一条问题或建议，且五个维度点评不能全空，否则视为无效输出
  const hasComment = Object.values(diagnosis.dimensions).some((d) => d.comment)
  if (!hasComment && diagnosis.problems.length === 0 && diagnosis.suggestions.length === 0) {
    return null
  }
  return diagnosis
}

export interface DiagnosisInput {
  topic: string
  identityLabel: string
  style: string
  category: string
  blueprint?: CreativeBlueprint | null
  sampleText: string
}

/**
 * 调用 DeepSeek 对成稿做五维诊断（强制 JSON 输出）。
 * 仅服务端使用；失败返回 null，调用方决定降级（前端静默/允许重试）。
 */
export async function generateDiagnosis(
  input: DiagnosisInput
): Promise<Omit<CreativeDiagnosis, 'diagnosedAt'> | null> {
  const system = [
    '你是资深短视频内容总编，每年审稿数千条，诊断以犀利、具体、可执行著称，从不给客套话。',
    '任务：对给定的解说成稿做一次完整体检，输出结构化 JSON 诊断报告。',
    '硬性要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    '2. 所有内容用中文；点评必须引用/对应稿件中的具体写法，禁止"引人入胜""节奏不错"这类空话；',
    '3. level 为严格的 1-5 整数：5=突出 4=良好 3=中规中矩 2=偏弱 1=待提升。评分要真实、敢给低分，五个维度允许相同；',
    '4. 不要输出百分制分数；',
    '5. JSON 必须严格包含以下 key：',
    'dimensions{opening{level,comment}, structure{level,comment}, emotion{level,comment}, style_fit{level,comment}, virality{level,comment}},',
    'strengths[string], problems[string], suggestions[string],',
    'next_actions{hit,style,emotion,depth,video,script}（每个值一句话，说明"选择该方向后下一步具体怎么改"，必须与本篇稿件的实际问题挂钩）。',
  ].join('\n')

  const user = `请诊断以下成稿：

解说主题：${input.topic}
创作者身份：${input.identityLabel || '未记录'}
文风要求：${input.style || '由身份自然决定'}
内容品类：${input.category || '未指定'}
${input.blueprint ? `${formatBlueprintForPrompt(input.blueprint)}\n` : ''}
【待诊断成稿】
${input.sampleText.slice(0, 6000)}

请逐维度点评：
- opening：开头 3 秒 Hook 是否具体、有悬念/反差，第一句话值不值得停下来；
- structure：段落递进、信息密度、是否有冗余或断裂；
- emotion：情绪曲线是否成立、共鸣点是否落地；
- style_fit：叙述人格、句式、节奏与上方身份/文风要求的贴合程度；
- virality：记忆点、互动引导、被转发的理由（不要给百分比，只给等级和理由）。
strengths/problems/suggestions 各给 2-4 条，问题与建议要一一可落地。`

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
        temperature: 0.3,
        max_tokens: 1600,
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      console.error('作品诊断失败:', await res.text())
      return null
    }
    const data = await res.json()
    const text: string = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) return null

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const parsed: unknown = JSON.parse(cleaned)
    return normalizeDiagnosis(parsed)
  } catch (e) {
    console.error('作品诊断异常:', e)
    return null
  }
}

/** 从任意来源（DB jsonb）安全解析一份带时间戳的完整诊断 */
export function parseDiagnosis(raw: unknown): CreativeDiagnosis | null {
  const base = normalizeDiagnosis(raw)
  if (!base) return null
  const o = (raw ?? {}) as Record<string, unknown>
  const diagnosedAt = typeof o.diagnosedAt === 'string' ? o.diagnosedAt : new Date().toISOString()
  return { ...base, diagnosedAt }
}

/** 供 API 层把库内蓝图 jsonb 安全转成诊断输入 */
export function blueprintFromRaw(raw: unknown): CreativeBlueprint | null {
  return normalizeBlueprint(raw)
}
