// 用户风格记忆（纯前端 localStorage，无需登录即可生效）
// 注意：只保存在当前浏览器，清除缓存会丢失
// 第九阶段安全修复：同一浏览器内按登录用户分桶，避免切换账号后风格记忆串号

import { userScopedKey } from './storageOwner'

export interface StyleMemoryEntry {
  id: string
  createdAt: string
  identityLabel: string // 本次使用的身份（官方模板名 / 自定义身份名）
  style: string // 本次填写的文风描述（可为空）
  category: string // 本次内容类型（含自定义类型文本）
  sampleText: string // 本次生成的范文
  favorited: boolean // 用户收藏 → 标记为【用户偏爱范文】
}

const STYLE_MEMORY_KEY = 'style_memory'
const MAX_ENTRIES = 50 // 防止无限膨胀，只保留最近 50 次

export function getStyleMemory(): StyleMemoryEntry[] {
  try {
    const key = userScopedKey(STYLE_MEMORY_KEY)
    // 归属未就绪：返回空，绝不读取他人风格记忆
    if (!key) return []
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 每次生成成功后记录一条；可传入与作品相同的 id，便于 /article 页关联收藏状态 */
export function recordGeneration(input: {
  id?: string
  identityLabel: string
  style: string
  category: string
  sampleText: string
}): string {
  const id = input.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    const key = userScopedKey(STYLE_MEMORY_KEY)
    if (!key) return id
    const list = getStyleMemory()
    list.unshift({
      id,
      createdAt: new Date().toISOString(),
      identityLabel: input.identityLabel,
      style: input.style,
      category: input.category,
      sampleText: input.sampleText,
      favorited: false,
    })
    localStorage.setItem(
      key,
      JSON.stringify(list.slice(0, MAX_ENTRIES))
    )
  } catch {
    // localStorage 不可用（隐私模式/空间已满）时静默失败，不影响生成主流程
  }
  return id
}

/** 按 id 查单条记忆（/article/[id] 页读取收藏状态用） */
export function getMemoryEntry(id: string): StyleMemoryEntry | null {
  return getStyleMemory().find((e) => e.id === id) ?? null
}

/** 收藏 / 取消收藏某次范文（收藏 = 用户偏爱范文） */
export function setFavorite(id: string, favorited: boolean): void {
  try {
    const key = userScopedKey(STYLE_MEMORY_KEY)
    if (!key) return
    const list = getStyleMemory().map((e) =>
      e.id === id ? { ...e, favorited } : e
    )
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    // 同上
  }
}

/** 清空全部风格记忆（仅清当前用户桶） */
export function clearStyleMemory(): void {
  try {
    const key = userScopedKey(STYLE_MEMORY_KEY)
    if (!key) return
    localStorage.removeItem(key)
  } catch {
    // 同上
  }
}

/**
 * 聚合统计用户长期偏好（前端完成统计，结果随生成请求传给后端注入 prompt）
 * - 高频身份 / 常用文风 / 常用品类：按出现次数取前 3
 * - 偏爱范文：取最近 3 篇收藏的摘录，供大模型体会语感、句式、金句习惯
 *
 * 注意：此函数返回所有偏爱范文摘录，不做主题相关性筛选。
 * 跨主题生成时（如昨天僵尸先生 → 今天商业计划书）会污染当前主题。
 * 请优先使用 buildMemorySummaryForTopic(topic) 按主题过滤。
 */
export function buildMemorySummary(): {
  identities: string
  styles: string
  categories: string
  favoredExcerpts: string
} {
  const list = getStyleMemory()

  function topN(values: string[], n = 3): string {
    const counter = new Map<string, number>()
    values.filter((v) => v.trim()).forEach((v) => {
      counter.set(v, (counter.get(v) ?? 0) + 1)
    })
    const ranked = [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([v, c]) => `${v}（${c}次）`)
    return ranked.length ? ranked.join('、') : '暂无'
  }

  const favored = list.filter((e) => e.favorited)
  const favoredExcerpts = favored.length
    ? favored
        .slice(0, 3)
        .map((e, i) => `摘录${i + 1}：${e.sampleText.slice(0, 150)}…`)
        .join('\n')
    : '暂无收藏范文'

  return {
    identities: topN(list.map((e) => e.identityLabel)),
    styles: topN(list.map((e) => e.style)),
    categories: topN(list.map((e) => e.category)),
    favoredExcerpts,
  }
}

// ── 主题相关性过滤（解决跨主题污染）──────────────────────────────

/**
 * 中文分词的极简实现：按 2-3 字滑窗提取 token。
 * 不依赖分词库，不调 embedding 服务，零成本零延迟。
 * 用于偏爱范文与当前主题的 token overlap 相关性判断。
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  const cleaned = text.replace(/[\s\u3000，。、；：？！,.;:?!()\[\]{}"""''《》〈〉「」『』]/g, '')
  // 2 字滑窗（中文语义基本单元）
  for (let i = 0; i < cleaned.length - 1; i++) {
    tokens.add(cleaned.slice(i, i + 2))
  }
  // 3 字滑窗（提升精确匹配权重）
  for (let i = 0; i < cleaned.length - 2; i++) {
    tokens.add(cleaned.slice(i, i + 3))
  }
  // 单字兜底（避免极短主题匹配不到任何 token）
  for (const ch of cleaned) tokens.add(ch)
  return tokens
}

/**
 * 计算 token 集合的 Jaccard 相似度。
 * 取值 0-1，0=完全无交集，1=完全相同。
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const t of a) {
    if (b.has(t)) intersection++
  }
  return intersection / (a.size + b.size - intersection)
}

/**
 * 基于当前主题过滤偏爱范文：只保留与主题 token 相似度 ≥ 阈值 的摘录。
 * 命中 0 篇时返回空串（不注入比乱注入好）。
 * 高频身份/常用文风/常用品类统计保留（这些是抽象特征，污染风险低）。
 */
export function buildMemorySummaryForTopic(topic: string): {
  identities: string
  styles: string
  categories: string
  favoredExcerpts: string
} {
  const list = getStyleMemory()
  const topicTokens = topic.trim() ? tokenize(topic) : new Set<string>()

  function topN(values: string[], n = 3): string {
    const counter = new Map<string, number>()
    values.filter((v) => v.trim()).forEach((v) => {
      counter.set(v, (counter.get(v) ?? 0) + 1)
    })
    const ranked = [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([v, c]) => `${v}（${c}次）`)
    return ranked.length ? ranked.join('、') : '暂无'
  }

  // 偏爱范文按主题相关性筛选：Jaccard 相似度阈值 0.08
  // （2-3 字滑窗下，0.08 已能过滤掉完全不同主题的范文，
  //  同主题或近义主题能保留 1-3 篇；阈值偏松，宁可漏召回也不污染）
  const FAVORED_SIMILARITY_THRESHOLD = 0.08
  const favored = list.filter((e) => e.favorited)
  const matchedFavored = favored
    .map((e) => ({
      entry: e,
      sim: jaccardSimilarity(topicTokens, tokenize(e.sampleText.slice(0, 200))),
    }))
    .filter((x) => x.sim >= FAVORED_SIMILARITY_THRESHOLD)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 3)

  const favoredExcerpts = matchedFavored.length
    ? matchedFavored
        .map((x, i) => `摘录${i + 1}（主题相似度 ${(x.sim * 100).toFixed(0)}%）：${x.entry.sampleText.slice(0, 150)}…`)
        .join('\n')
    : '' // 命中 0 篇时返回空串，不注入

  return {
    identities: topN(list.map((e) => e.identityLabel)),
    styles: topN(list.map((e) => e.style)),
    categories: topN(list.map((e) => e.category)),
    favoredExcerpts,
  }
}
