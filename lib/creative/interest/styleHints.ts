// ============================================================
// Creator Interest Profile —— 风格适配（S7）
//
// 解决的缺口：style_profiles 的偏好/禁忌此前只服务"生成正文"（creatorModel），
// 推荐侧完全没读过。结果是推荐可能推到用户明确排斥的方向上——用户写了
// 「绝对避免空洞鸡汤」，推荐照样给"写一篇情感共鸣文"。
//
// 三条用法，严格区分软硬：
//   1. favorites/topics → 软引导：只写进 S4 探索 prompt，让 LLM 往这些方向靠。
//      绝不用于打分加权——偏好是"怎么写/喜欢什么元素"，不是"这个选题更值得写"，
//      混进评分会让推荐退化成对既有偏好的复读。
//   2. avoid → 硬约束：候选命中即剔除（filterByAvoid）。
//      与 creatorModel 设计原则第 2 条一致（"avoid_elements 是硬禁忌"）。
//   3. 无风格数据（新用户）→ 全程 no-op，零影响、零 prompt 开销。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { extractStylePrefs, type StylePrefs } from '../creatorModel'

export interface StyleHints {
  /** 偏好的表达元素（软引导） */
  favorites: string[]
  /** 持续关注的母题（软引导） */
  topics: string[]
  /** 绝对回避元素（硬约束） */
  avoids: string[]
}

/** style_profiles 中本模块需要的列（全部是基线列，所有环境都存在） */
const STYLE_HINT_COLUMNS = 'creator_personality, topic_preferences, favorite_elements, avoid_elements'

/** 空提示常量：无风格数据时复用同一对象，避免各处各造一个 */
export const EMPTY_STYLE_HINTS: StyleHints = { favorites: [], topics: [], avoids: [] }

/**
 * 风格卡原始行 → 提示结构。
 * 三个数组全空时返回 null（调用方据此整块跳过，未建模用户零开销）。
 */
export function normalizeStyleHints(raw: unknown): StyleHints | null {
  if (!raw || typeof raw !== 'object') return null
  const prefs: StylePrefs = extractStylePrefs(raw as Record<string, unknown>)
  const hints: StyleHints = {
    favorites: prefs.favorites,
    topics: prefs.topics,
    avoids: prefs.avoid,
  }
  if (!hints.favorites.length && !hints.topics.length && !hints.avoids.length) return null
  return hints
}

/**
 * 读取用户风格提示。
 * 全程吞错：风格适配是增强项，读不到最坏结果是"不做适配"，
 * 绝不能让推荐链路因此失败。
 */
export async function loadStyleHints(
  supabase: SupabaseClient,
  userId: string
): Promise<StyleHints | null> {
  try {
    const { data, error } = await supabase
      .from('style_profiles')
      .select(STYLE_HINT_COLUMNS)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) {
      console.warn('[interest] 风格提示读取失败，跳过 S7 适配:', error.message)
      return null
    }
    return normalizeStyleHints(data as Record<string, unknown> | null)
  } catch (e) {
    console.warn('[interest] 风格提示读取异常，跳过 S7 适配:', e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * 格式化为 S4 探索 prompt 的一行约束。
 *
 * 刻意只输出一行：S4 的输入已经包含 ≤6 个兴趣种子 + 去重 label 列表，
 * 再塞整块人格描述会挤占输出条数所需的 token 预算（表现为后半批被截断降级）。
 *
 * @param maxItems 每类最多列举几项（默认 5，控制行长）
 */
export function formatStyleHintsForPrompt(hints: StyleHints | null, maxItems = 5): string {
  if (!hints) return ''
  const parts: string[] = []
  if (hints.favorites.length) {
    parts.push(`偏好表达元素：${hints.favorites.slice(0, maxItems).join('、')}`)
  }
  if (hints.topics.length) {
    parts.push(`长期母题：${hints.topics.slice(0, maxItems).join('、')}`)
  }
  if (hints.avoids.length) {
    parts.push(`绝对回避（命中即作废）：${hints.avoids.slice(0, maxItems).join('、')}`)
  }
  if (!parts.length) return ''
  return `这位创作者的表达偏好：${parts.join('；')}`
}

/**
 * 候选是否命中回避元素（硬约束判定）。
 *
 * 只在 title/description/topic 三处做子串匹配：这三处是用户实际看到并据此
 * 判断"要不要写"的文本。evidence/keywords 等内部结构不参与——它们是溯源数据，
 * 拿去匹配会造成"内部字段里出现关键词就被过滤"的误杀。
 */
export function violatesAvoid(
  cand: { title?: string; description?: string; topic?: string },
  avoids: string[]
): boolean {
  if (!avoids.length) return false
  const text = [cand.title, cand.description, cand.topic].filter(Boolean).join(' ')
  if (!text) return false
  for (const a of avoids) {
    if (!a) continue
    if (text.includes(a)) return true
  }
  return false
}

/** 过滤掉命中回避元素的候选（无回避项时原样返回，零开销） */
export function filterByAvoid<T extends { title: string; description: string; topic: string }>(
  candidates: T[],
  hints: StyleHints | null
): T[] {
  if (!hints?.avoids.length) return candidates
  const before = candidates.length
  const kept = candidates.filter((c) => !violatesAvoid(c, hints.avoids))
  const dropped = before - kept.length
  if (dropped > 0) {
    console.warn(`[interest] 风格硬禁忌过滤：剔除 ${dropped} 个命中回避元素的候选`)
  }
  return kept
}
