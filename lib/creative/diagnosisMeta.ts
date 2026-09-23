// ============================================================
// 诊断领域的「纯」部分：类型、展示元数据、归一化函数
//
// 本模块必须保持零运行时依赖（不 import 任何含 LLM 调用 / process.env 的模块），
// 这样 'use client' 组件引用它时不会把服务端模块（lib/llm 及 DeepSeek 密钥读取）
// 连带打进浏览器 bundle。诊断的 LLM 调用留在 ./diagnosis（仅服务端）。
// ============================================================

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

/** 库内 jsonb → 诊断对象（补 diagnosedAt） */
export function parseDiagnosis(raw: unknown): CreativeDiagnosis | null {
  const base = normalizeDiagnosis(raw)
  if (!base) return null
  const o = (raw ?? {}) as Record<string, unknown>
  const diagnosedAt = typeof o.diagnosedAt === 'string' ? o.diagnosedAt : new Date().toISOString()
  return { ...base, diagnosedAt }
}
