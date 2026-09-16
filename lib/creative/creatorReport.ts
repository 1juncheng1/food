// ============================================================
// Creator Report —— 版本化「创作 DNA」报告（style_profiles.creator_report）
//
// 产品原则（不可破坏）：
// 1. 数字有出处：formDna/openingDna/measured 是服务端确定性计数；
//    motifDna/narrativeDna 的标签由 AI 归纳，但必须引用真实样本作为证据，
//    权重 = 服务端校验通过的引用篇数 / 样本总数（绝不采信 AI 自报的百分比）；
// 2. 用户声明权威：bounds 直接镜像 favorite_elements/avoid_elements，AI 不覆盖；
// 3. 置信度由样本量代码计算，AI 不自夸；
// 4. 一次分析 = 一个不可变版本，整体替换，version 递增；
// 5. 本模块为纯函数，不读库不调 LLM，可在任意服务端路由/测试中复用。
// ============================================================

import {
  computeBasicStats,
  detectPace,
  openingCounts,
  toneTagCounts,
} from './languageStats'

/** 一个 DNA 维度（母题/叙事/形式/开头共用） */
export interface DnaItem {
  /** 维度标签，如「人性」「人物心理切入」「故事文案」 */
  label: string
  /** 0~1 关联度：证据篇数 / 样本总数（确定性重算） */
  weight: number
  /** 证据命中的样本篇数 */
  count: number
  /** 证据原文（作品 topic 或素材片段，供 UI 展示"根据什么"） */
  evidence: string[]
}

/** 创作 DNA 报告（creator_report 列的完整结构） */
export interface CreatorReport {
  /** 报告结构版本（每次重新理解 +1，首次为 1） */
  version: number
  updatedAt: string
  /** 分析覆盖的样本总数（作品 + 素材） */
  sampleCount: number
  sources: {
    works: number
    materials: number
    /** 五维画像沉淀的行为信号数（like/dislike/选版/选方向） */
    signals: number
  }
  /** 0.2~0.9，代码按样本量计算 */
  confidence: number
  personality: {
    main: string
    sub: string
    description: string
  }
  /** 内容形式分布（确定性：品类计数，如 故事文案 8/12） */
  formDna: DnaItem[]
  /** 母题 DNA（AI 标签 + 真实样本证据 + 代码重算权重） */
  motifDna: DnaItem[]
  /** 叙事 DNA（同上） */
  narrativeDna: DnaItem[]
  /** 开头方式分布（确定性：提问式/叙事式/其他） */
  openingDna: DnaItem[]
  languageDna: {
    /** 确定性语气命中（篇数） */
    measured: { label: string; count: number }[]
    /** AI 归纳的语言风格词（定性，不做分数） */
    aiLabels: string[]
    pace: string
    avgLength: number
  }
  /** 创作边界（镜像用户声明，权威） */
  bounds: {
    favorite: string[]
    avoid: string[]
  }
}

/** summarize API 收集的原始样本 */
export interface ReportInput {
  works: {
    topic?: string | null
    category?: string | null
    sample_text?: string | null
  }[]
  materials: {
    category?: string | null
    content?: string | null
  }[]
  /** 五维画像行为信号样本数 */
  signals: number
  /** 用户手动声明（权威边界） */
  declared: {
    favorite: string[]
    avoid: string[]
  }
  /** 上一版报告（version 递增用，没有则为 null） */
  previous: Pick<CreatorReport, 'version'> | null
}

/** LLM 返回的草稿（只负责命名/定性/选证据，不负责数字） */
interface LlmDraft {
  main: string
  sub: string
  description: string
  motifs: { label: string; refs: string[] }[]
  narratives: { label: string; refs: string[] }[]
  language: string[]
}

// ── 小工具 ──────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function cleanStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, '').slice(0, max) : ''
}

function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().replace(/\r\n/g, '\n').slice(0, max) : ''
}

function strList(v: unknown, itemMax = 30, maxCount = 15): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const t = x.trim()
    if (t && !out.includes(t)) out.push(t.slice(0, itemMax))
    if (out.length >= maxCount) break
  }
  return out
}

function normalize(s: string): string {
  return s.replace(/\s+/g, '')
}

// ── 读库解析 ─────────────────────────────────────────────────

/** 严格解析 creator_report；任何结构异常返回 null（调用处回退旧总结展示） */
export function parseCreatorReport(raw: unknown): CreatorReport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.version !== 'number' || typeof r.updatedAt !== 'string') return null
  const p = r.personality as Record<string, unknown> | undefined
  if (!p || typeof p.main !== 'string' || typeof p.description !== 'string') return null
  return r as unknown as CreatorReport
}

/** 报告是否为空壳（9.6 列默认 '{}'） */
export function hasCreatorReport(raw: unknown): boolean {
  return parseCreatorReport(raw) !== null
}

// ── 确定性骨架 ───────────────────────────────────────────────

function distribution(
  labeled: { category: string }[],
  totalForWeight: number
): DnaItem[] {
  const counts = new Map<string, number>()
  for (const { category } of labeled) {
    if (!category) continue
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([label, count]) => ({
      label,
      count,
      weight: totalForWeight > 0 ? round2(count / totalForWeight) : 0,
      evidence: [],
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
}

/**
 * 置信度：样本量占 70%（20 篇封顶），行为信号占 20%（10 个封顶），
 * 基数 0.2——2 篇样本时明确"仍在形成中"，样本充分也不到 1.0（创作风格本就持续演化）。
 */
export function computeConfidence(sampleCount: number, signals: number): number {
  const samplePart = Math.min(sampleCount / 20, 1)
  const signalPart = Math.min(signals / 10, 1)
  return round2(clamp(0.2 + 0.5 * samplePart + 0.2 * signalPart, 0.2, 0.9))
}

/** 喂给 LLM 的客观数据包（含编号清单，refs 必须引用其中主题原文） */
export function buildStatsBrief(input: ReportInput): {
  brief: string
  allContents: string[]
} {
  const { works, materials, signals, declared } = input
  const allContents = [
    ...works.map((w) => w.sample_text ?? '').filter(Boolean),
    ...materials.map((m) => m.content ?? '').filter(Boolean),
  ]

  const workCats = works.filter((w) => w.category).map((w) => ({ category: w.category as string }))
  const matCats = materials.filter((m) => m.category).map((m) => ({ category: m.category as string }))
  const formCounts = distribution([...workCats, ...matCats], workCats.length + matCats.length)
  const openings = openingCounts(allContents)
  const tones = toneTagCounts(allContents).filter((t) => t.count > 0)
  const basic = computeBasicStats(allContents)

  const lines: string[] = []
  lines.push(`【内容形式分布（确定性统计）】`)
  lines.push(
    formCounts.length
      ? formCounts.map((d) => `${d.label} ${d.count} 篇（${Math.round(d.weight * 100)}%）`).join('；')
      : '无分类数据'
  )
  lines.push(
    `\n【开头方式】提问式 ${openings.question} 篇、叙事式 ${openings.narrative} 篇、其他 ${openings.other} 篇`
  )
  lines.push(`【节奏/篇幅】${detectPace(allContents)}；平均 ${basic.avg_length} 字/篇`)
  lines.push(
    `【语气词命中】${tones.length ? tones.map((t) => `${t.label} ${t.count} 篇`).join('、') : '暂无明显命中'}`
  )
  lines.push(`【行为信号】累计 ${signals} 条（喜欢/不喜欢/定稿/选方向等真实选择）`)
  if (declared.favorite.length) lines.push(`【用户声明喜欢】${declared.favorite.join('、')}`)
  if (declared.avoid.length) lines.push(`【用户声明排斥】${declared.avoid.join('、')}`)

  lines.push(`\n【作品 ${works.length} 篇（编号供引用）】`)
  works.forEach((w, i) => {
    const topic = w.topic?.trim() || '未命名主题'
    const head = (w.sample_text ?? '').replace(/\s+/g, ' ').slice(0, 300)
    lines.push(`[W${i + 1}] 主题：${topic}｜形式：${w.category ?? '未分类'}\n片段：${head}`)
  })

  lines.push(`\n【素材 ${materials.length} 条（编号供引用）】`)
  materials.forEach((m, i) => {
    const head = (m.content ?? '').replace(/\s+/g, ' ').slice(0, 150)
    lines.push(`[M${i + 1}] 形式：${m.category ?? '未分类'}｜${head}`)
  })

  return { brief: lines.join('\n'), allContents }
}

// ── LLM 草稿解析与证据校验 ────────────────────────────────────

/** 解析 LLM 的 JSON 输出；结构缺失或 JSON 非法返回 null */
export function parseLlmDraft(raw: string): LlmDraft | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const obj = JSON.parse(cleaned) as Record<string, unknown>
    const main = cleanStr(obj.main, 12)
    const description = cleanText(obj.description, 500)
    if (!main || !description) return null

    const toRefItems = (v: unknown): { label: string; refs: string[] }[] => {
      if (!Array.isArray(v)) return []
      const out: { label: string; refs: string[] }[] = []
      for (const it of v) {
        if (!it || typeof it !== 'object') continue
        const rec = it as Record<string, unknown>
        const label = cleanStr(rec.label, 10)
        if (!label) continue
        const refs = strList(rec.refs, 60, 6)
        out.push({ label, refs })
      }
      return out
    }

    return {
      main,
      sub: cleanStr(obj.sub, 12),
      description,
      motifs: toRefItems(obj.motifs).slice(0, 4),
      narratives: toRefItems(obj.narratives).slice(0, 4),
      language: strList(obj.language, 10, 6),
    }
  } catch {
    return null
  }
}

/**
 * 校验 AI 给的 refs：必须与真实样本（作品 topic / 素材开头）双向子串匹配。
 * 权重完全由校验后的引用篇数决定，AI 给的任何数字都不采信。
 */
function resolveDna(
  items: { label: string; refs: string[] }[],
  evidencePool: string[],
  sampleTotal: number,
  maxItems: number
): DnaItem[] {
  const normPool = evidencePool.map((e) => ({ raw: e, norm: normalize(e) })).filter((e) => e.norm.length >= 4)
  const seenLabels = new Set<string>()
  const resolved: DnaItem[] = []

  for (const item of items) {
    if (seenLabels.has(item.label)) continue
    const matched: string[] = []
    for (const refRaw of item.refs) {
      const ref = normalize(refRaw)
      if (ref.length < 4) continue
      const hit = normPool.find(
        (p) => p.norm.includes(ref) || (ref.length >= 6 && ref.includes(p.norm.slice(0, 24)))
      )
      if (hit && !matched.includes(hit.raw)) matched.push(hit.raw)
    }
    if (matched.length === 0) continue // 无真实证据的维度直接丢弃
    seenLabels.add(item.label)
    resolved.push({
      label: item.label,
      count: matched.length,
      weight: sampleTotal > 0 ? round2(clamp(matched.length / sampleTotal, 0.05, 0.98)) : 0,
      evidence: matched.slice(0, 6),
    })
  }

  return resolved.sort((a, b) => b.count - a.count).slice(0, maxItems)
}

/** 组装最终报告（确定性骨架 + 校验后的 AI 解读） */
export function assembleCreatorReport(input: ReportInput, draft: LlmDraft): CreatorReport {
  const { works, materials, signals, declared, previous } = input
  const sampleCount = works.length + materials.length
  const allContents = [
    ...works.map((w) => w.sample_text ?? '').filter(Boolean),
    ...materials.map((m) => m.content ?? '').filter(Boolean),
  ]

  // 证据池：作品 topic（优先）+ 素材内容开头。
  // 口径必须与 buildStatsBrief 喂给 LLM 的素材片段（前 150 字）一致，否则合法引用会被判无效。
  const evidencePool = [
    ...works.map((w) => w.topic?.trim() ?? '').filter(Boolean),
    ...materials.map((m) => (m.content ?? '').replace(/\s+/g, ' ').slice(0, 150)).filter(Boolean),
  ]

  const labeledWorks = works.filter((w) => w.category).map((w) => ({ category: w.category as string }))
  const labeledMaterials = materials
    .filter((m) => m.category)
    .map((m) => ({ category: m.category as string }))
  const formDna = distribution([...labeledWorks, ...labeledMaterials], labeledWorks.length + labeledMaterials.length)

  const totalOpenings = allContents.length
  const oc = openingCounts(allContents)
  const openingDna: DnaItem[] = [
    { label: '提问式', count: oc.question, weight: 0, evidence: [] },
    { label: '叙事式', count: oc.narrative, weight: 0, evidence: [] },
    { label: '其他', count: oc.other, weight: 0, evidence: [] },
  ]
    .filter((d) => d.count > 0)
    .map((d) => ({ ...d, weight: totalOpenings ? round2(d.count / totalOpenings) : 0 }))

  return {
    version: typeof previous?.version === 'number' && previous.version > 0 ? previous.version + 1 : 1,
    updatedAt: new Date().toISOString(),
    sampleCount,
    sources: { works: works.length, materials: materials.length, signals },
    confidence: computeConfidence(sampleCount, signals),
    personality: {
      main: draft.main,
      sub: draft.sub,
      description: draft.description,
    },
    formDna,
    motifDna: resolveDna(draft.motifs, evidencePool, sampleCount, 4),
    narrativeDna: resolveDna(draft.narratives, evidencePool, sampleCount, 4),
    openingDna,
    languageDna: {
      measured: toneTagCounts(allContents)
        .filter((t) => t.count > 0)
        .map((t) => ({ label: t.label, count: t.count })),
      aiLabels: draft.language,
      pace: detectPace(allContents),
      avgLength: computeBasicStats(allContents).avg_length,
    },
    bounds: {
      favorite: declared.favorite.slice(0, 15),
      avoid: declared.avoid.slice(0, 15),
    },
  }
}

// ── Prompt 注入（供 creatorModel 复用） ──────────────────────

/** 把 DNA 报告格式化为创作者人格 prompt 块；空报告返回空串 */
export function formatCreatorReportForPrompt(report: CreatorReport): {
  text: string
  avoid: string[]
  layers: string[]
  traits: AppliedTrait[]
} {
  const layers: string[] = []
  const lines: string[] = []
  lines.push('【创作者人格 · 该用户的长期创作身份（自然贴合，禁止在正文中提及这些设定本身）】')

  const p = report.personality
  if (p.main) {
    lines.push(`创作者定位：${p.main}${p.sub ? `（创作副线：${p.sub}）` : ''}`)
    layers.push('创作者人格定位')
  }
  if (p.description) {
    lines.push(`对该创作者的理解：${p.description}`)
    layers.push('AI 对你的创作理解')
  }

  const pct = (d: DnaItem) => `${d.label}（关联 ${d.count}/${report.sampleCount} 篇）`
  if (report.motifDna.length) {
    lines.push(
      `持续关注的母题：${report.motifDna.map(pct).join('、')}（与本次主题相关时优先深挖；主题不同则以本次主题为准，不得强行套用）`
    )
    layers.push('偏好题材')
  }
  if (report.narrativeDna.length) {
    lines.push(`叙事倾向（合适时自然延续，不生搬）：${report.narrativeDna.map(pct).join('、')}`)
    layers.push('叙事偏好')
  }
  // 开头方式习惯（确定性分布，如"提问式 6/10 篇"）——第五阶段补齐：让 AI 连开场惯例都延续
  if (report.openingDna.length) {
    lines.push(
      `惯用开头方式：${report.openingDna.map(pct).join('、')}（本次开头优先贴合该创作者最顺手的方式，除非蓝图明确指定别的 Hook）`
    )
    layers.push('开头习惯')
  }
  // 内容形式分布（确定性品类计数）——第五阶段补齐：形式偏好是创作者 DNA 的一部分
  if (report.formDna.length) {
    lines.push(`擅长/高频的内容形式：${report.formDna.map(pct).join('、')}`)
    layers.push('内容形式偏好')
  }

  const langParts = [
    ...report.languageDna.aiLabels,
    ...(report.languageDna.pace !== '未知' ? [`${report.languageDna.pace}`] : []),
  ]
  if (langParts.length || report.languageDna.measured.length) {
    const measured = report.languageDna.measured.map((m) => `${m.label}×${m.count}篇`)
    lines.push(
      `语言特质：${langParts.join('、') || '—'}${measured.length ? `（统计语气：${measured.join('、')}）` : ''}`
    )
    layers.push('语言风格画像')
  }

  if (report.bounds.favorite.length) {
    lines.push(`偏好的表达元素（在合适处自然运用，不要堆砌）：${report.bounds.favorite.join('、')}`)
    layers.push('喜欢的表达元素')
  }
  if (report.bounds.avoid.length) {
    lines.push(`绝对避免的元素（硬禁忌，任何情况下都不要出现）：${report.bounds.avoid.join('、')}`)
    layers.push('排斥元素硬禁忌')
  }

  // 第七阶段：提取本次实际采用的创作者特征（每维度取最高频条目，附真实历史占比）
  const traits: AppliedTrait[] = []
  if (p.main) traits.push({ dimension: '创作者定位', label: p.main })
  if (report.motifDna.length)
    traits.push({
      dimension: '主题偏好',
      label: report.motifDna[0].label,
      ratio: report.motifDna[0].count / report.sampleCount,
    })
  if (report.narrativeDna.length)
    traits.push({
      dimension: '叙事偏好',
      label: report.narrativeDna[0].label,
      ratio: report.narrativeDna[0].count / report.sampleCount,
    })
  if (report.openingDna.length)
    traits.push({
      dimension: '开头习惯',
      label: report.openingDna[0].label,
      ratio: report.openingDna[0].count / report.sampleCount,
    })
  if (report.formDna.length)
    traits.push({
      dimension: '内容形式',
      label: report.formDna[0].label,
      ratio: report.formDna[0].count / report.sampleCount,
    })
  const topLanguage = report.languageDna.aiLabels[0]
  if (topLanguage) traits.push({ dimension: '语言特质', label: topLanguage })

  return { text: `\n\n${lines.join('\n')}`, avoid: report.bounds.avoid, layers, traits }
}

/** 第七阶段：本次实际采用的创作者特征（全部为真实统计数据，供作品页展示） */
export interface AppliedTrait {
  /** 维度名（创作者定位/主题偏好/叙事偏好/开头习惯/内容形式/语言特质） */
  dimension: string
  /** 特征名（DNA 顶层条目或人格定位） */
  label: string
  /** 真实历史占比（count/sampleCount，0-1）；人格定位/语言特质类无占比时省略 */
  ratio?: number
}
