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

/**
 * 一次作品诊断。
 *
 * 精简后的诊断只保留用户真正会读的两段：
 *   - strengths：表现良好（做得好的地方，保持）
 *   - improvements：需要改进（问题 + 怎么改，一句话可执行）
 * 五维等级（dimensions）、问题/建议分列（problems/suggestions）、
 * 六类下一步（nextActions）已从 LLM 输出中移除——它们占掉的 token 远超
 * 用户从中获得的信息量，且大部分内容与上述两段重复。
 *
 * 旧字段保留为可选：库内历史 jsonb 仍可能带着它们，读取时照旧解析，
 * 只是不再展示、不再要求 AI 产出。
 */
/** 三镜头诊断的镜头键：观点 / 证据 / 表达 */
export type DiagnosisLensKey = 'viewpoint' | 'evidence' | 'expression'

export interface DiagnosisLens {
  /** 这个镜头下做得好的地方（一句话） */
  good: string
  /** 这个镜头下最该改的一处（问题 → 怎么改，一句话） */
  fix: string
}

/** 三镜头展示元数据（前端共用，顺序即展示顺序） */
export const DIAGNOSIS_LENS_META: Array<{
  key: DiagnosisLensKey
  label: string
  hint: string
}> = [
  { key: 'viewpoint', label: '观点', hint: '主张是否立得住、有没有自己的判断' },
  { key: 'evidence', label: '证据', hint: '论据是否具体、能否真正支撑观点' },
  { key: 'expression', label: '表达', hint: '语言是否到位、节奏是否适合读下去' },
]

export interface CreativeDiagnosis {
  /** 表现良好：明确做得好的地方（引用稿件具体写法） */
  strengths: string[]
  /** 需要改进：问题 → 怎么改（每条一句话，可照做） */
  improvements: string[]
  diagnosedAt: string // 诊断时间（ISO，服务端写入）
  /**
   * 三镜头诊断（可选）：从 观点 / 证据 / 表达 三个角度各给一条 good 与 fix。
   * 旧诊断与历史 jsonb 没有此字段 → 前端回退到 strengths / improvements 两段展示。
   */
  lenses?: Partial<Record<DiagnosisLensKey, DiagnosisLens>>
  /** @deprecated 旧版遗留：五维定性等级 + 逐维点评，新诊断不再产出 */
  dimensions?: Record<DimensionKey, DiagnosisDimension>
  /** @deprecated 旧版遗留：问题清单，新诊断已并入 improvements */
  problems?: string[]
  /** @deprecated 旧版遗留：建议清单，新诊断已并入 improvements */
  suggestions?: string[]
  /** @deprecated 旧版遗留：六类下一步方向，新诊断不再产出 */
  nextActions?: Record<NextActionKey, string>
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

  const strengths = strList(o.strengths, 3, 200)
  let improvements = strList(o.improvements, 3, 240)
  // 旧数据没有 improvements：用当时的 问题 + 建议 兜底，保证历史作品仍有内容可看
  if (improvements.length === 0) {
    improvements = [...strList(o.problems, 3, 240), ...strList(o.suggestions, 3, 240)].slice(0, 3)
  }
  // 两段都空 = 无效输出（等于什么都没诊断出来）
  if (strengths.length === 0 && improvements.length === 0) return null

  const diagnosis: Omit<CreativeDiagnosis, 'diagnosedAt'> = { strengths, improvements }

  // ── 以下为旧版遗留字段：仅当库内 jsonb 真的带着时才透出，不再主动补齐 ──
  if (typeof o.dimensions === 'object' && o.dimensions !== null) {
    const rawDims = o.dimensions as Record<string, unknown>
    const dimEntry = (key: DimensionKey): DiagnosisDimension => {
      const d =
        typeof rawDims[key] === 'object' && rawDims[key] !== null
          ? (rawDims[key] as Record<string, unknown>)
          : {}
      const comment =
        typeof d.comment === 'string' && d.comment.trim() ? d.comment.trim().slice(0, 300) : ''
      return { level: clampLevel(d.level), comment }
    }
    diagnosis.dimensions = {
      opening: dimEntry('opening'),
      structure: dimEntry('structure'),
      emotion: dimEntry('emotion'),
      style_fit: dimEntry('style_fit'),
      virality: dimEntry('virality'),
    }
  }
  // ── 三镜头诊断（可选）：LLM 漏字段或旧数据时为 undefined，前端回退两段展示 ──
  if (typeof o.lenses === 'object' && o.lenses !== null) {
    const rawLenses = o.lenses as Record<string, unknown>
    const lensEntry = (key: DiagnosisLensKey): DiagnosisLens | null => {
      const l = rawLenses[key]
      if (typeof l !== 'object' || l === null) return null
      const lo = l as Record<string, unknown>
      const one = (v: unknown): string =>
        typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : ''
      const good = one(lo.good)
      const fix = one(lo.fix)
      if (!good && !fix) return null
      return { good, fix }
    }
    const lenses: Partial<Record<DiagnosisLensKey, DiagnosisLens>> = {}
    for (const m of DIAGNOSIS_LENS_META) {
      const entry = lensEntry(m.key)
      if (entry) lenses[m.key] = entry
    }
    if (Object.keys(lenses).length > 0) diagnosis.lenses = lenses
  }

  const problems = strList(o.problems, 4, 300)
  const suggestions = strList(o.suggestions, 4, 300)
  if (problems.length) diagnosis.problems = problems
  if (suggestions.length) diagnosis.suggestions = suggestions

  if (typeof o.next_actions === 'object' && o.next_actions !== null) {
    const rawActions = o.next_actions as Record<string, unknown>
    const action = (key: NextActionKey): string =>
      typeof rawActions[key] === 'string' ? (rawActions[key] as string).trim().slice(0, 300) : ''
    const nextActions: Record<NextActionKey, string> = {
      hit: action('hit'),
      style: action('style'),
      emotion: action('emotion'),
      depth: action('depth'),
      video: action('video'),
      script: action('script'),
      // custom 不由诊断 LLM 输出，恒为空串（前端渲染自定义输入卡，不读该值）
      custom: '',
    }
    if (Object.values(nextActions).some(Boolean)) diagnosis.nextActions = nextActions
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
