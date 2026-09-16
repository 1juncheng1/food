// ============================================================
// 创作档案（Creation Archive）——前后端共享类型与纯函数
// 用户把一次 AI 创作过程（灵感 → 方向 → 版本迭代 → 最终作品）
// 以「只读快照」发布到灵感广场。
//
// 关键原则：
// 1. archive 是发布瞬间的快照——作品之后继续迭代不影响已发布档案；
// 2. 历史版本只快照 方向/修改说明/短摘要，只有最终版存全文（控制 jsonb 体积）；
// 3. 快照由服务端从 creative_projects + generation_history 构建，前端不可伪造。
// ============================================================

import { NEXT_ACTION_META } from './diagnosis'
import type { CreativeBlueprint } from './blueprint'

/** 单个历史版本的档案摘要（不存全文） */
export interface ArchiveVersion {
  n: number // 版本号
  direction: string | null // hit/style/emotion/depth/video/script/custom；V1 为 null
  directionLabel: string | null // 方向中文名（V1 为 null）
  directionEmoji: string | null
  note: string | null // AI 修改说明 improve_note
  excerpt: string // 正文开头短摘要（约 200 字）
  createdAt: string
}

/** 创作档案快照（posts.archive jsonb 的结构） */
export interface ArchiveSnapshot {
  title: string
  inspiration: string // 灵感起点（用户可编辑的一句话/一段话）
  blueprintSummary: {
    // AI 创作方向（取自 V1 蓝图；adopt 的老作品无蓝图时为 null）
    positioning: string
    audience: string
    hook: string
    conflict: string
    emotionCurve: string
    persona: string
  } | null
  versions: ArchiveVersion[]
  finalVersionNumber: number
  finalWork: string // 最终版全文
  authorSummary: string | null // 作者总结（选填）
  styleTags: string[] // 身份/文风等标签（展示用）
  publishedAt: string
}

/** 方向 key → 展示元数据（容忍库内未知值） */
export function directionMeta(key: string | null | undefined): {
  label: string | null
  emoji: string | null
} {
  if (!key) return { label: null, emoji: null }
  const meta = NEXT_ACTION_META.find((m) => m.key === key)
  return meta ? { label: meta.label, emoji: meta.emoji } : { label: key, emoji: '↻' }
}

/** 正文摘要：折叠空白，取开头指定字数 */
export function makeExcerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 从蓝图提取「AI 创作方向」展示摘要（缺字段的容错为空串） */
export function summarizeBlueprint(
  raw: unknown
): ArchiveSnapshot['blueprintSummary'] {
  if (typeof raw !== 'object' || raw === null) return null
  const bp = raw as Partial<CreativeBlueprint>
  const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const summary = {
    positioning: s(bp.positioning),
    audience: s(bp.target_audience),
    hook: s(bp.opening_hook),
    conflict: s(bp.core_conflict),
    emotionCurve: s(bp.emotion_curve),
    persona: s(bp.persona_hint),
  }
  // 六个字段全空说明蓝图数据无效
  return Object.values(summary).some(Boolean) ? summary : null
}

/** 服务端构建快照的输入行（与 generation_history 查询字段对应） */
export interface ArchiveVersionRow {
  versionNumber: number
  improveDirection: string | null
  improveNote: string | null
  sampleText: string
  blueprint: unknown
  createdAt: string
}

/**
 * 构建档案快照（纯函数，便于推理）。
 * versions 需按版本号正序；finalVersionNumber 指定最终版（通常为项目 current_version）。
 */
export function buildArchiveSnapshot(input: {
  title: string
  inspiration: string
  authorSummary: string | null
  styleTags: string[]
  versions: ArchiveVersionRow[]
  finalVersionNumber: number
}): ArchiveSnapshot | null {
  const rows = [...input.versions].sort((a, b) => a.versionNumber - b.versionNumber)
  if (rows.length === 0) return null
  const finalRow =
    rows.find((r) => r.versionNumber === input.finalVersionNumber) ?? rows[rows.length - 1]
  if (!finalRow?.sampleText?.trim()) return null

  const firstBlueprint = rows.map((r) => r.blueprint).find(Boolean) ?? null

  return {
    title: input.title,
    inspiration: input.inspiration,
    blueprintSummary: summarizeBlueprint(firstBlueprint),
    versions: rows.map((r) => {
      const { label, emoji } = directionMeta(r.improveDirection)
      return {
        n: r.versionNumber,
        direction: r.improveDirection,
        directionLabel: r.improveDirection ? label : null,
        directionEmoji: r.improveDirection ? emoji : null,
        note: r.improveNote?.trim() || null,
        excerpt: makeExcerpt(r.sampleText || ''),
        createdAt: r.createdAt,
      }
    }),
    finalVersionNumber: finalRow.versionNumber,
    finalWork: finalRow.sampleText,
    authorSummary: input.authorSummary,
    styleTags: input.styleTags,
    publishedAt: new Date().toISOString(),
  }
}

/** 档案帖在普通信息流里的兜底文本（embedding + 摘要展示用） */
export function archiveFeedText(snapshot: ArchiveSnapshot): string {
  const tail = `（创作档案 · ${snapshot.versions.length} 个版本 · 最终 V${snapshot.finalVersionNumber}）`
  return `${snapshot.inspiration}\n\n${tail}`
}
