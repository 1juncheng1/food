// ============================================================
// 语言一致性（Language Consistency）—— LLM 输出语言跟随用户输入
//
// 为什么需要独立模块：
//   改造前全仓库 24 个 LLM 调用点里，语言约束是硬编码的「所有内容用中文」，
//   另有 9 个调用点连约束都没有。后果是：用户用英文提需求 → AI 中文作答；
//   用户输入日文素材 → 五维诊断跑出中文点评。这类跑偏在patch链路尤其致命，
//   因为它直接改写用户的正文。
//
// 三层保障（缺一层就够不上"稳定"）：
//   1. 检测层  detectLanguage          确定性 Unicode script 统计，不烧 token、无网络
//   2. 指令层  languageDirective       产出与检测同口径的 prompt 约束，含技术字段豁免
//   3. 守卫层  checkLanguageConsistency 对 LLM 输出做同口径校验（由 lib/llm.ts 触发重试）
//
// 设计取舍：
//   - 不用 LLM 判断语言。一是每次调用多一轮延迟，二是判断本身会因为
//     "看起来像翻译腔"而抖动；字符统计对同一段输入永远给出同一答案。
//   - 保守回退。拉丁语系彼此相似（es/fr/it/pt），只有明显领先时才细分，
//     否则统一判 en——错判成英文远好过把西语识别成意大利语。
//   - unknown 不等于"不约束"。检测失败时指令退化为
//     "与用户输入完全保持一致"，而不是放弃语言约束。
// ============================================================

/** 支持的输出语言。unknown 表示样本不足，交给 LLM 自行对齐输入 */
export type LanguageCode =
  | 'zh-CN'
  | 'zh-TW'
  | 'en'
  | 'ja'
  | 'ko'
  | 'es'
  | 'fr'
  | 'de'
  | 'pt'
  | 'it'
  | 'ru'
  | 'ar'
  | 'unknown'

/** 书写系统（比语种更稳的中间层，用于容差判定） */
export type ScriptKind =
  | 'han'
  | 'latin'
  | 'kana'
  | 'hangul'
  | 'cyrillic'
  | 'arabic'
  | 'unknown'

export interface LanguageDetection {
  language: LanguageCode
  /** 主导书写系统 */
  script: ScriptKind
  /** 0-1，主 script 的字符占比即为置信度基准 */
  confidence: number
  /** 可读依据，用于日志排查"为什么判成这个语言" */
  evidence: string
}

const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  'zh-CN': '简体中文（Simplified Chinese）',
  'zh-TW': '繁體中文（Traditional Chinese）',
  en: 'English',
  ja: '日本語（Japanese）',
  ko: '한국어（Korean）',
  es: 'Español（Spanish）',
  fr: 'Français（French）',
  de: 'Deutsch（German）',
  pt: 'Português（Portuguese）',
  it: 'Italiano（Italian）',
  ru: 'Русский（Russian）',
  ar: 'العربية（Arabic）',
  unknown: '与用户输入一致的语言（the same language as the user input）',
}

/** 语言 → 人类可读名称（指令与日志共用同一份，避免文案漂移） */
export function languageName(lang: LanguageCode): string {
  return LANGUAGE_NAMES[lang] ?? LANGUAGE_NAMES.unknown
}

// ─── 预处理：剥离不该参与统计的内容 ────────────────────────
//
// URL / 邮箱 / 代码 / 数字 / 标点 / emoji 在任何语言里都会出现，
// 留着会稀释真正的语言信号（一篇中文技术文章里塞满 URL 就可能被判成拉丁文）。

const STRIP_PATTERNS = [
  /https?:\/\/\S+/gi,
  /\b[\w.+-]+@[\w-]+\.[\w.]+\b/gi,
  /```[\s\S]*?```/g,
  /`[^`]*`/g,
  /#[^\s#]{1,30}/g, // 话题标签，内容语种混杂且常为拉丁
]

/** 单个字符的 script 归类（热路径，避免重复构造正则） */
const RE_KANA = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/
const RE_HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/
const RE_HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const RE_CYRILLIC = /[\u0400-\u04ff\u0500-\u052f]/
const RE_ARABIC = /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/
const RE_LATIN = /[a-zA-Z\u00c0-\u024f\u0370-\u03ff]/

function scriptOf(ch: string): ScriptKind {
  if (RE_KANA.test(ch)) return 'kana'
  if (RE_HANGUL.test(ch)) return 'hangul'
  if (RE_HAN.test(ch)) return 'han'
  if (RE_CYRILLIC.test(ch)) return 'cyrillic'
  if (RE_ARABIC.test(ch)) return 'arabic'
  if (RE_LATIN.test(ch)) return 'latin'
  return 'unknown'
}

// ─── 简繁判定 ──────────────────────────────────────────────
//
// 只收录「简繁不同形」的特征字：两边列表互斥，避免重复计数互相抵消。
// 例外的同形字（如「学/學」之外的「天」「人」）不进表，因为它们没有区分度。

// 两张表必须互斥（同一个字不能两边都有），否则计数互相抵消失去区分度。
// 收录原则是「高频 + 简繁不同形」：同形字（人、天、文）没有区分度，不收录。
const SIMPLIFIED_CHARS =
  '个们来时说国学电车马书门问间饭红纸经给觉记讲认识应该关风云飞员专区处务发东乐' +
  '这为产业动样点体头线声对总实么办还过语话读写听开后几张长将于无双会标题' +
  '画够鲜调节构师场热脑术爱义级组织终结统万亿钱岁丽'

const TRADITIONAL_CHARS =
  '個們來時說國學電車馬書門問間飯紅紙經給覺記講認識應該關風雲飛員專區處務發東樂' +
  '這為產業動樣點體頭線聲對總實麼辦還過語話讀寫聽開後幾張長將於無雙會標題' +
  '畫夠鮮調節構師場熱腦術愛義級組織終結統萬億錢歲麗'

function countChars(text: string, table: string): number {
  let n = 0
  for (const ch of text) if (table.includes(ch)) n++
  return n
}

/**
 * 判定汉字样本的简体 / 繁体变体。
 * 保守策略：只有繁体特征明显多于简体（≥2 且 ≥2倍）才判 zh-TW，
 * 其余一律 zh-CN——把简体误判成繁体比反过来更刺眼，且平台主体用户是简体。
 */
function hanVariant(text: string): 'zh-CN' | 'zh-TW' {
  const trad = countChars(text, TRADITIONAL_CHARS)
  const simp = countChars(text, SIMPLIFIED_CHARS)
  return trad >= 2 && trad >= simp * 2 ? 'zh-TW' : 'zh-CN'
}

// ─── 拉丁语系细分（保守回退到 en）──────────────────────────
//
// es/fr/pt/it 共享大量同源词，逐词打分容易打成平票。这里取最高分后，
// 要求它至少领先第二名一倍才采信，否则一律判 en。

const LATIN_HINTS: Record<string, ReadonlySet<string>> = {
  es: new Set(['el', 'la', 'los', 'las', 'de', 'que', 'con', 'para', 'por', 'una', 'más', 'pero', 'como', 'está', 'son']),
  fr: new Set(['le', 'les', 'des', 'une', 'est', 'pour', 'avec', 'dans', 'qui', 'pas', 'plus', 'cette', 'sont', 'être']),
  de: new Set(['der', 'die', 'das', 'und', 'ist', 'eine', 'mit', 'auf', 'nicht', 'sie', 'wir', 'von', 'sich', 'werden']),
  pt: new Set(['os', 'as', 'uma', 'para', 'não', 'mais', 'com', 'uma', 'são', 'está', 'isso', 'você']),
  it: new Set(['il', 'lo', 'gli', 'che', 'una', 'per', 'con', 'non', 'sono', 'del', 'della', 'più', 'questo']),
  en: new Set(['the', 'and', 'is', 'are', 'to', 'of', 'in', 'that', 'for', 'with', 'this', 'have', 'not', 'you', 'will']),
}

function latinLanguage(text: string): LanguageCode {
  const words = text.toLowerCase().match(/[a-z\u00e0-\u024f]+/g)
  if (!words || words.length === 0) return 'en'

  const scores: Record<string, number> = {}
  for (const [lang, hints] of Object.entries(LATIN_HINTS)) {
    let n = 0
    for (const w of words) if (hints.has(w)) n++
    scores[lang] = n
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const [top, topScore] = ranked[0]
  const runnerUp = ranked[1]?.[1] ?? 0

  // 证据不足，或优势不明显 → 英文。英文是跨语言场景的默认公约数
  if (topScore === 0 || topScore < runnerUp * 2) return 'en'
  return top as LanguageCode
}

/** 检测样本上限：占比统计到几千字符已稳定，没必要全文遍历 */
const MAX_SAMPLE = 5000

/**
 * 检测文本语言。
 *
 * 判定顺序刻意固定，先后顺序本身就是规则：
 *   1. 假名 → ja（日文几乎必然含假名，这是比汉字更硬的指标）
 *   2. 谚文 → ko
 *   3. 汉字占比达标 → zh（含"中文夹英文术语"这一最常见的混写场景）
 *   4. 西里尔 / 阿拉伯 → ru / ar
 *   5. 拉丁 → 按特征词细分
 *   6. 其余 → unknown
 *
 * 第 3 条的阈值 0.15 是关键：中文技术写作里夹英文单词很常见，
 * 若按"占比最大者胜"会被几个长英文单词翻盘，导致把中文to判成英文。
 */
export function detectLanguage(raw: string): LanguageDetection {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { language: 'unknown', script: 'unknown', confidence: 0, evidence: 'empty input' }
  }

  let text = raw.slice(0, MAX_SAMPLE)
  for (const re of STRIP_PATTERNS) text = text.replace(re, ' ')

  const counts: Record<ScriptKind, number> = {
    han: 0, latin: 0, kana: 0, hangul: 0, cyrillic: 0, arabic: 0, unknown: 0,
  }
  let total = 0

  for (const ch of text) {
    if (/\s/.test(ch)) continue
    if (/[\p{P}\p{S}\p{N}]/u.test(ch)) continue // 标点/符号/数字不携带语种信号
    counts[scriptOf(ch)]++
    total++
  }

  if (total === 0) {
    return { language: 'unknown', script: 'unknown', confidence: 0, evidence: 'no script characters' }
  }

  const ratio = (s: ScriptKind) => counts[s] / total
  const conf = (s: ScriptKind) => Number(ratio(s).toFixed(2))

  // 1. 日文：只要出现假名就足以判定（中文正文中不会出现假名）
  if (counts.kana > 0 && counts.hangul === 0) {
    return { language: 'ja', script: 'kana', confidence: conf('kana'), evidence: `kana chars=${counts.kana}` }
  }
  // 2. 韩文
  if (counts.hangul > 0 && counts.hangul >= counts.kana) {
    return { language: 'ko', script: 'hangul', confidence: conf('hangul'), evidence: `hangul chars=${counts.hangul}` }
  }
  // 3. 中文（含中英混写）
  if (ratio('han') >= 0.15) {
    const lang = hanVariant(text)
    return {
      language: lang,
      script: 'han',
      confidence: conf('han'),
      evidence: `han ratio=${conf('han')} (≥0.15 counts as zh), variant=${lang}`,
    }
  }
  // 4. 西里尔 / 阿拉伯
  if (ratio('cyrillic') >= 0.3) {
    return { language: 'ru', script: 'cyrillic', confidence: conf('cyrillic'), evidence: `cyrillic ratio=${conf('cyrillic')}` }
  }
  if (ratio('arabic') >= 0.3) {
    return { language: 'ar', script: 'arabic', confidence: conf('arabic'), evidence: `arabic ratio=${conf('arabic')}` }
  }
  // 5. 拉丁细分
  if (ratio('latin') >= 0.3) {
    const lang = latinLanguage(text)
    return { language: lang, script: 'latin', confidence: conf('latin'), evidence: `latin ratio=${conf('latin')}, hint=${lang}` }
  }

  return {
    language: 'unknown',
    script: 'unknown',
    confidence: 0,
    evidence: `no dominant script (han=${counts.han}, latin=${counts.latin}, kana=${counts.kana}, hangul=${counts.hangul})`,
  }
}

// ─── 多候选裁决 ────────────────────────────────────────────

export interface LanguageCandidate {
  text: string | null | undefined
  /** 权重：越高越优先。正文这类"用户已产出内容"应高于一行补充说明 */
  weight: number
  /** 标签，用于日志与测试断言（如 'article' / 'feedback' / 'topic'） */
  label: string
}

export interface ResolvedLanguage {
  language: LanguageCode
  /** 采纳了哪个候选 */
  source: string
  detection: LanguageDetection
}

/**
 * 从多条候选文本中定出目标语言。
 *
 * 为什么不是简单取第一条：真实请求里经常只有部分是有效样本——
 * 用户点了"爆款优化"按钮但没填意见（feedback 为空）、topic 是历史遗留的英文、
 * 正文却是一篇中文稿。逐个按权重尝试，取第一个能明确判出的结果。
 *
 * 全部 unknown 时返回 unknown（而不是默认中文）——检测不出就该让 LLM 自行对齐输入，
 * 这比猜一个语言更安全。
 */
export function resolveTargetLanguage(candidates: LanguageCandidate[]): ResolvedLanguage {
  const ranked = [...candidates].sort((a, b) => b.weight - a.weight)

  for (const c of ranked) {
    if (!c.text || !c.text.trim()) continue
    const d = detectLanguage(c.text)
    if (d.language !== 'unknown') {
      return { language: d.language, source: c.label, detection: d }
    }
  }

  return {
    language: 'unknown',
    source: ranked.length > 0 ? ranked[0].label : 'none',
    detection: { language: 'unknown', script: 'unknown', confidence: 0, evidence: 'all candidates undetectable' },
  }
}

// ─── 指令层 ────────────────────────────────────────────────

export interface DirectiveOptions {
  /**
   * 豁免字段：这些字段是技术标识符，不许跟随输出语言。
   * 例如 interest/naming 要求 slug 必须是 c_xxx 蛇形英文码，若被"请用中文输出"
   * 带偏会导致下游解析失败——这是全局语言指令最容易踩的坑。
   */
  exemptFields?: string[]
  /** 附加说明（如"正文已有 settled 风格"），追加在指令末尾 */
  extra?: string
}

/**
 * 生成注入 LLM 的语言约束。
 *
 * 与直接写"请用中文"相比多了两件事：
 *   1. 点名 exempt（豁免）字段，把"哪些字段例外"讲清楚——否则 LLM 看到
 *      "除涉及技术的字段"理解成豁免句首就够，仍然时常把 slug 中文化）
 *   2. 明确"跟随输入"而非指定某个语言——用户中途换语言也能跟上
 */
export function languageDirective(lang: LanguageCode, opts: DirectiveOptions = {}): string {
  const name = languageName(lang)
  const lines: string[] = []

  if (lang === 'unknown') {
    lines.push(
      '- 【输出语言】与你收到的用户输入文本保持完全一致：用户用什么语言写，你就用什么语言回答。',
      '- 若输入里确实无法判断语言（例如只有数字或符号），默认使用简体中文。'
    )
  } else {
    lines.push(
      `- 【输出语言】所有面向用户的文字必须使用 ${name}，与用户的输入语言保持一致。`,
      '- 适用于：标题、正文、摘要、建议、点评、解释说明、选项文案等一切给用户看的内容。',
      '- 即使用户输入的个别词语是外语，整体输出语言也不改变（例如中文正文里夹带英文术语时，仍用中文作答）。'
    )
  }

  if (opts.exemptFields?.length) {
    lines.push(
      `- 例外：以下字段属于技术标识符，必须保持其固有格式，**不得**翻译成${lang === 'unknown' ? '其他' : '目标'}语言——${opts.exemptFields.join('、')}。`
    )
  } else {
    lines.push(
      '- 例外：技术标识符（id / slug / snake_case、camelCase 字段名）、代码、URL、命令、专有名词缩写保持原样，不要翻译或本地化。'
    )
  }

  if (opts.extra) lines.push(`- ${opts.extra}`)

  return lines.join('\n')
}

// ─── 守卫层 ────────────────────────────────────────────────

export interface ConsistencyCheck {
  /** 是否与目标一致（含同语系容差） */
  consistent: boolean
  target: LanguageCode
  detected: LanguageDetection
  /** 人类可读结论，写进日志便于事后复盘哪些调用点容易跑偏 */
  note: string
}

/** 语言族：简繁、以及无法细分的拉丁语系视为同一族，避免苛判引发无意义重试 */
function family(lang: LanguageCode): string {
  if (lang === 'zh-CN' || lang === 'zh-TW') return 'zh'
  return lang
}

/**
 * 校验 LLM 输出是否符合目标语言。
 *
 * @param text 待检内容。JSON 场景请先抽出字符串字段拼接后再传入，
 *             否则大量英文 key（"summary"、"reason"）会把占比拉向英文而误判。
 */
export function checkLanguageConsistency(text: string, target: LanguageCode): ConsistencyCheck {
  if (target === 'unknown') {
    return {
      consistent: true,
      target,
      detected: { language: 'unknown', script: 'unknown', confidence: 0, evidence: 'no target, skip' },
      note: 'target is unknown, skipped',
    }
  }

  const detected = detectLanguage(text)

  if (family(detected.language) === family(target)) {
    return { consistent: true, target, detected, note: `matches target (${detected.evidence})` }
  }

  // 目标明确但样本不足（例如输出极短只有数字）→ 放行，不重试
  if (detected.language === 'unknown') {
    return { consistent: true, target, detected, note: 'output undetectable, skipped' }
  }

  return {
    consistent: false,
    target,
    detected,
    note: `expected ${target} but output looks like ${detected.language} (${detected.evidence})`,
  }
}

/**
 * 从 LLM 的 JSON 输出里抽出「面向用户的文本」用于语言校验。
 *
 * 为什么必须单独抽：JSON 的 key 恒为英文且数量众多，直接对原始字符串做
 * script 统计会被 key 淹没——一篇纯中文的诊断 JSON 会被判成 latin。
 * 同理，值是技术标识符（slug / id / 枚举 / URL）的字段也要跳过。
 */
export function extractUserFacingText(raw: unknown, opts: { maxItems?: number } = {}): string {
  const maxItems = opts.maxItems ?? 200
  const out: string[] = []

  const push = (v: string) => {
    const t = v.trim()
    if (!t) return
    // 技术形态跳过：纯蛇形/驼峰标识、URL、纯符号数字
    if (/^[\w-]+$/.test(t) && /^[a-z][a-z0-9_]*$/.test(t)) return
    if (/^https?:\/\//i.test(t)) return
    out.push(t)
  }

  const walk = (node: unknown, depth: number) => {
    if (out.length >= maxItems || depth > 6) return
    if (typeof node === 'string') {
      push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node === 'object' && node !== null) {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v, depth + 1)
    }
  }

  walk(raw, 0)
  return out.join('\n')
}
