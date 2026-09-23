// ============================================================
// Creator Interest Profile -- 注入生成 prompt 的文本块（纯函数）
//
// 存在意义：
//   interest_profile（Creator Understanding Engine 画像视图）此前长期「算了不用」：
//   builder 写入 style_profiles，但生成链路从未 select 该列，导致 AI 生成时
//   完全不知道「用户长期关注什么」。本模块把它转成可读、可控、可测试的 prompt 块。
//
// 设计原则：
//   1. 纯函数：不读库、不调 LLM；理由文案与 profileAssembly 同源（行为事实模板）
//   2. 只做「参考事实」，不做硬约束：由行为推断出的负向倾向绝不加进 creatorAvoid。
//      理由：declaration（用户主动声明）才是权威边界（见 creatorDeclaration.ts），
//      行为信号只允许软参考，硬约束会放大统计噪声对创作的干扰。
//   3. 空画像（{} 默认列值 = 未建模）整块剔除，未建模用户零影响、零字数开销
//   4. 严格总量预算：防止挤占主题 / 素材 / 历史作品等既有区块的上下文配额
// ============================================================

/** 画像中的单条主题兴趣（profileAssembly.topic_interest 的形态） */
export interface TopicInterest {
  name: string
  /** 0-100 量纲的兴趣强度 */
  weight: number
  /** 行为事实理由（非 LLM 生成），用于让 AI 理解「为什么认为用户关注它」 */
  reason: string
}

/** 近期创作方向（profileAssembly.recent_creation_direction 的形态） */
export interface RecentDirection {
  code?: string
  label?: string
  recentEvents?: number
}

/**
 * 生成链路真正消费的画像快照。
 * 只保留注入要用到的字段，避免把整个 jsonb 结构耦合进 prompt 层。
 */
export interface InterestProfileSnapshot {
  topicInterest: TopicInterest[]
  /** 核心层簇标签（长期稳定投入的领域） */
  coreLabels: string[]
  recentDirection: RecentDirection | null
  /** 领域分布，已按占比降序裁剪 */
  domains: Array<{ name: string; share: number }>
  /** 画像完整度 0-1 */
  completeness: number
  schemaVersion: number
}

function s(v: unknown, max: number): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * 兜底清洗 interest_profile jsonb。
 * 空对象 / 非对象 / 无有效主题兴趣则返回 null（调用方整块剔除）。
 */
export function normalizeInterestProfile(raw: unknown): InterestProfileSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const topicInterest: TopicInterest[] = []
  if (Array.isArray(o.topic_interest)) {
    for (const item of o.topic_interest as unknown[]) {
      if (typeof item !== 'object' || item === null) continue
      const t = item as Record<string, unknown>
      const name = s(t.name, 40)
      if (!name) continue
      topicInterest.push({
        name,
        weight: Math.round(num(t.weight, 0, 100, 0)),
        reason: s(t.reason, 120),
      })
    }
  }

  const coreLabels: string[] = []
  if (Array.isArray(o.core)) {
    for (const item of o.core as unknown[]) {
      if (typeof item !== 'object' || item === null) continue
      const label = s((item as Record<string, unknown>).label, 40)
      if (label && !coreLabels.includes(label)) coreLabels.push(label)
    }
  }

  let recentDirection: RecentDirection | null = null
  if (typeof o.recent_creation_direction === 'object' && o.recent_creation_direction !== null) {
    const r = o.recent_creation_direction as Record<string, unknown>
    const label = s(r.label, 40)
    if (label) {
      recentDirection = {
        code: s(r.code, 40) || undefined,
        label,
        recentEvents: Math.round(num(r.recentEvents, 0, 9999, 0)),
      }
    }
  }

  const domains: Array<{ name: string; share: number }> = []
  if (typeof o.domains === 'object' && o.domains !== null) {
    for (const [k, v] of Object.entries(o.domains as Record<string, unknown>)) {
      const name = s(k, 40)
      const share = num(v, 0, 1, 0)
      if (name && share > 0) domains.push({ name, share })
    }
    domains.sort((a, b) => b.share - a.share)
    if (domains.length > 5) domains.length = 5
  }

  const identity =
    typeof o.identity === 'object' && o.identity !== null
      ? (o.identity as Record<string, unknown>)
      : {}
  const completeness = num(identity.completeness, 0, 1, Math.min(1, topicInterest.length / 8))
  const schemaVersion = Math.round(num(o.schema_version, 0, 999, 0))

  // 无主题兴趣且无领域分布，视为未建模
  if (topicInterest.length === 0 && domains.length === 0) return null

  return { topicInterest, coreLabels, recentDirection, domains, completeness, schemaVersion }
}

export interface InterestPromptOptions {
  /** 最多注入的主题数（默认 6） */
  maxTopics?: number
  /** 最多注入的领域数（默认 4） */
  maxDomains?: number
  /** 整块最大字符数预算（默认 600） */
  maxLength?: number
  /** 低于该强度的主题不注入，过滤长尾噪声（默认 5） */
  minWeight?: number
}

/**
 * 格式化为注入生成 prompt 的文本块。
 *
 * 定位说明（写进块里让模型自己知道边界）：
 *   这是「用户长期关注领域」的统计观察，用于帮助选定切入角度与选材倾向，
 *   不是硬性命题；当它与本次主题无关时应被忽略。这条正是
 *   Creator Intelligence System 里「相关性判断」的人类可读兜底。
 */
export function formatInterestForPrompt(
  snapshot: InterestProfileSnapshot | null,
  opts?: InterestPromptOptions
): string {
  if (!snapshot) return ''

  const maxTopics = opts?.maxTopics ?? 6
  const maxDomains = opts?.maxDomains ?? 4
  const maxLength = opts?.maxLength ?? 600
  const minWeight = opts?.minWeight ?? 5

  const topics = snapshot.topicInterest.filter((t) => t.weight >= minWeight).slice(0, maxTopics)
  const domains = snapshot.domains.slice(0, maxDomains)
  if (topics.length === 0 && domains.length === 0) return ''

  const lines: string[] = ['【该创作者的长期关注领域】（由历史创作与互动行为统计得出）']

  if (topics.length > 0) {
    lines.push('长期关注：')
    for (const t of topics) {
      const reason = t.reason ? '，' + t.reason : ''
      lines.push('  - ' + t.name + '（强度 ' + t.weight + '/100' + reason + '）')
    }
  }

  if (snapshot.coreLabels.length > 0) {
    lines.push('稳定深耕：' + snapshot.coreLabels.slice(0, 5).join('、'))
  }

  if (snapshot.recentDirection?.label) {
    const n = snapshot.recentDirection.recentEvents ?? 0
    lines.push(
      '近期方向：' + snapshot.recentDirection.label + (n > 0 ? '（近 7 天 ' + n + ' 次相关行为）' : '')
    )
  }

  if (domains.length > 0) {
    lines.push(
      '领域分布：' +
        domains.map((d) => d.name + ' ' + Math.round(d.share * 100) + '%').join('，')
    )
  }

  let text = lines.join('\n')

  // 预算守卫：整块超预算时按行截断（保留标题与最长关注列表）
  if (text.length > maxLength) {
    const kept: string[] = []
    let len = 0
    for (const line of lines) {
      if (len + line.length + 1 > maxLength) break
      kept.push(line)
      len += line.length + 1
    }
    text = kept.join('\n')
  }

  return (
    text +
    '\n用法：仅作为选题角度与素材倾向的参考，不得当成硬性命题；' +
    '若本次主题与上述领域无关，忽略本块即可。'
  )
}

/** 从原始 jsonb 一步到位拿到 prompt 文本块（生成链路的便捷入口） */
export function buildInterestBlock(
  raw: unknown,
  opts?: InterestPromptOptions
): { text: string; snapshot: InterestProfileSnapshot | null } {
  const snapshot = normalizeInterestProfile(raw)
  return { text: formatInterestForPrompt(snapshot, opts), snapshot }
}
