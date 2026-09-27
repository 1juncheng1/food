// ============================================================
// Preference Reason（修改原因抽取）—— 纯函数，零 LLM
//
// 存在意义：系统要记住的不是"用户改了什么"，而是"用户为什么改"。
//
//   反例（只记结果）：改了开头 → 下次还是不知道他想要什么
//   正例（记原因）：「不要太像新闻」→ 用户偏好：个人观点表达
//                  「不要太复杂」→ 用户偏好：大众理解优先
//
// 这条数据是长期资产：它决定未来 AI 生成时的默认取向，
// 也决定灵感推荐该往哪个方向推。改过一次，以后每次都受用。
//
// 为什么用规则而不是 LLM：
//   原话是短句（"不要太像新闻"仅 6 字），语义映射表比调用更快、更确定，
//   且这类高频表达是有限的、可枚举的。
// ============================================================

/** 单条从原话抽出的偏好原因 */
export interface PreferenceReason {
  /** avoid=用户不想要的表达方式；like=用户想更强的方向 */
  kind: 'avoid' | 'like'
  /**
   * 归一化后的偏好陈述（注入记忆与 prompt 的形态）。
   * 例：「不要太像新闻」→ "新闻通稿式的客观报道口径"（avoid）
   */
  statement: string
  /**
   * 该 avoid 背后的正向偏好（只有 avoid 类有值）。
   * 例：「不要太像新闻」→ "个人观点表达"
   * 没有它，avoid 只会让 AI 少做什么，不会让它知道该多做什么。
   */
  alternative?: string
  /** 抽取来源原话（≤80 字，溯源用） */
  source: string
}

/** 陈述最大长度（与 editingMemory 的 statement 上限一致，避免落库被截断） */
const MAX_STATEMENT_LEN = 50
/** 参与抽取的最小原话长度：两个字的反馈（"太平"）没有稳定的语义 */
const MIN_SOURCE_LEN = 4
/** 抽取出的词组太短则不采信：单字在中文里没有判别力 */
const MIN_TERM_LEN = 2

/**
 * 否定表达 → 语义映射。
 *
 * 顺序即优先级，命中第一条即返回。
 * statement 写"用户不要的那个东西"，alternative 写"他真正想要什么"。
 */
const AVOID_SEMANTICS: Array<{
  match: RegExp
  statement: string
  alternative?: string
}> = [
  {
    match: /(像|是|太)?(新闻|通稿|官方稿|报道稿|新闻稿)/,
    statement: '新闻通稿式的客观报道口径',
    alternative: '带个人观点的表达',
  },
  {
    match: /(像|是|太)?(AI|ai|机器|机器人|模板|套路化|通用)/,
    statement: '通用 AI 腔调',
    alternative: '有个人经验痕迹的表达',
  },
  {
    match: /(太|过于|比较)?(复杂|难懂|晦涩|绕|深奥|学术)/,
    statement: '难懂的复杂表达',
    alternative: '大众能一次读懂的说法',
  },
  {
    match: /(太|过于)?(专业|术语化|行话)/,
    statement: '满篇行话',
    alternative: '用案例解释专业概念',
  },
  {
    match: /(太|过于)?(长|啰嗦|冗长|拖沓|水)/,
    statement: '冗长注水的内容',
    alternative: '更高信息密度的写法',
  },
  {
    match: /(太|过于)?(平|平淡|无聊|没意思|没记忆点|寡淡)/,
    statement: '平铺直叙',
    alternative: '有起伏与记忆点的写法',
  },
  {
    match: /(太|过于)?(煽情|鸡汤|矫情|情绪化)/,
    statement: '空洞煽情',
    alternative: '用事实支撑的情绪',
  },
  {
    match: /(太|过于)?(硬|生硬|僵硬)/,
    statement: '生硬的转折与衔接',
    alternative: '更自然的叙述节奏',
  },
]

/**
 * 正向诉求 → 语义映射（"更 X" 句式）。
 * 用户说"更有观点"时，这不是 avoid，是可直接强化的 like。
 */
const LIKE_SEMANTICS: Array<{ match: RegExp; statement: string }> = [
  { match: /(观点|态度|立场|主张)/, statement: '鲜明的个人观点' },
  { match: /(案例|例子|故事|实例)/, statement: '具体的真实案例' },
  { match: /(数据|数字|统计)/, statement: '可核实的数据支撑' },
  { match: /(深度|思考|洞察|本质)/, statement: '有深度的分析' },
  { match: /(共鸣|情绪|感染力|打动)/, statement: '情绪共鸣' },
  { match: /(口语|自然|像说话|接地气)/, statement: '口语化的自然表达' },
  { match: /(专业|权威|严谨)/, statement: '专业严谨的论证' },
  { match: /(简洁|精炼|干脆|短)/, statement: '简洁精炼的表达' },
]

/**
 * 触发"不要 / 别 / 不想"这类否定词的模式。
 *
 * 约定：每组**第 1 个捕获组**才是被否定的内容，修饰词一律用非捕获组 `(?:…)`。
 * 不遵守这条会导致抽到「了」「一点」这类助词，语义映射永远落空。
 */
const NEGATION_PATTERNS: RegExp[] = [
  /不要(.{1,14})/,
  /别(?:太|那么|这么)?(.{1,12})/,
  /(?:不想|不希望|不喜欢)(.{1,12})/,
  /(?:太|过于)(.{1,12})/,
  /(?:少(?:一点|点|些)?|去掉)(.{1,12})/,
]

/** 触发"更 / 希望 / 想要"这类正向诉求的模式（同样只取第 1 捕获组） */
const DESIRE_PATTERNS: RegExp[] = [
  /(?:希望|想要|最好|能不能|能不能再|要)?更(?:加)?(.{1,12})/,
  /(?:再|多)(.{1,8})(?:一点|一些|些)/,
  /(?:加入|增加|加上|补充|加个|加点|加些)(.{1,12})/,
]

function trimTerm(raw: string): string {
  return raw
    .replace(/^(?:的|了|一点|一些|些|那么|这么|太|比较|有点|感觉|好像|[，。！？、；,.!?])+/, '')
    .replace(/(?:的|了|一点|一些|些|啊|吧|呢|吗|[，。！？、；,.!?])+$/, '')
    .trim()
    .slice(0, MAX_STATEMENT_LEN)
}

/**
 * 从用户反馈原话中抽取"为什么这样改"的偏好原因。
 *
 * 抽不出稳定语义时返回空数组——宁可什么都不记，也不要把噪声写进长期记忆
 * （editingMemory 有样本门槛，但错误的 statement 一旦过了门槛会长期误导生成）。
 */
export function extractPreferenceReasons(freeText: string): PreferenceReason[] {
  const text = (freeText ?? '').trim()
  if (text.length < MIN_SOURCE_LEN) return []

  const source = text.slice(0, 80)
  const out: PreferenceReason[] = []

  // ── 否定式：「不要太像新闻」──
  for (const p of NEGATION_PATTERNS) {
    const m = text.match(p)
    if (!m) continue
    const term = trimTerm((m[1] ?? '').trim())
    if (term.length < MIN_TERM_LEN) continue

    for (const s of AVOID_SEMANTICS) {
      if (s.match.test(term)) {
        out.push({
          kind: 'avoid',
          statement: s.statement,
          alternative: s.alternative,
          source,
        })
        break
      }
    }
  }

  // ── 正向式：「更有观点」「加个案例」──
  for (const p of DESIRE_PATTERNS) {
    const m = text.match(p)
    if (!m) continue
    const term = trimTerm((m[1] ?? '').trim())
    if (term.length < MIN_TERM_LEN) continue

    for (const s of LIKE_SEMANTICS) {
      if (s.match.test(term)) {
        out.push({ kind: 'like', statement: s.statement, source })
        break
      }
    }
  }

  // 同一陈述只留一条（"不要太长也不要太长"会命中两次）
  const seen = new Set<string>()
  return out.filter((r) => {
    const key = `${r.kind}:${r.statement}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
