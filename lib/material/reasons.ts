// ============================================================
// reasons —— 素材相关性理由生成
//
// 两种形态（plan 决策点 2，Option C 混合模式）：
//   1. buildTemplateReason：确定性模板，0 LLM、0 延迟、不会失败。
//      prompt-optimizer 内部固定只用模板（生产生成链路零新增 LLM）。
//   2. generateLlmReasons：一次 DeepSeek 批量调用，为全部候选逐条生成 ≤40 字
//      自然语言理由（Phase 4 素材选择步骤显式 opt-in）。
//      8s AbortController 超时；HTTP 非 2xx / 坏 JSON / id 对不上 → 返回 null，
//      调用方对每条整体回退模板（meta.degraded='llm_reason'）。
// ============================================================

import type { MaterialType } from '@/lib/creative/material'
import { callDeepSeekChat, stripJsonFence } from '@/lib/llm'

/** 模板理由所需的最小素材信号集（retrieval 层水合后的字段子集） */
export interface TemplateReasonInput {
  /** 原始相似度（未经软排序加分），0-1 */
  similarity: number
  materialType: MaterialType | null
  relatedTopics: string[] | null
}

/**
 * 模板理由：与主题语义相似度 82%；类型：数据；关联主题：创业、增长
 * 字段缺失的分段省略；无任何标签信息时退化为「与主题语义相似度 82%」。
 */
export function buildTemplateReason(input: TemplateReasonInput): string {
  const pct = `${Math.round(input.similarity * 100)}%`
  const parts: string[] = [`与主题语义相似度 ${pct}`]
  if (input.materialType) {
    parts.push(`类型：${input.materialType}`)
  }
  const topics = (input.relatedTopics ?? []).filter((t) => typeof t === 'string' && t.trim())
  if (topics.length > 0) {
    parts.push(`关联主题：${topics.slice(0, 3).join('、')}`)
  }
  return parts.join('；')
}

/** 用户主动选择素材的固定理由（selected 集不送 LLM） */
export const SELECTED_REASON = '用户主动选择'

// ── LLM 批量理由 ─────────────────────────────────────────

const LLM_TIMEOUT_MS = 8_000
const LLM_CONTENT_PREFIX = 300
const LLM_REASON_MAX_LEN = 40

export interface LlmReasonItemInput {
  id: string
  content: string
  materialType: MaterialType | null
}

/**
 * 一次 DeepSeek 批量调用为全部候选生成理由。
 * 返回 id → reason 的映射；任何失败形态（超时/非 2xx/坏 JSON/id 对不上）
 * 都返回 null，由调用方整体回退模板——绝不抛错、绝不部分返回。
 *
 * P1-补：改用 lib/llm.ts 共享封装（callDeepSeekChat），统一 timeout + 错误处理。
 */
export async function generateLlmReasons(
  topic: string,
  items: LlmReasonItemInput[]
): Promise<Record<string, string> | null> {
  if (items.length === 0) return {}

  const candidateList = items
    .map(
      (it, i) =>
        `${i + 1}. id=${it.id}${it.materialType ? `｜类型：${it.materialType}` : ''}｜内容：${it.content.slice(0, LLM_CONTENT_PREFIX)}`
    )
    .join('\n')

  const res = await callDeepSeekChat({
    messages: [
      {
        role: 'system',
        content:
          '你是素材相关性分析助手。针对每条素材，用一句不超过40字的中文说明它与创作主题为什么相关，必须具体、基于素材内容，不要空泛套话。严格只输出 JSON：{"reasons":[{"id":"素材id","reason":"≤40字理由"}]}，不要输出 markdown 代码块或任何解释。',
      },
      {
        role: 'user',
        content: `创作主题：${topic.slice(0, 200)}\n\n候选素材：\n${candidateList}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 600,
    jsonMode: true,
    timeoutMs: LLM_TIMEOUT_MS,
  })

  if (!res.ok) {
    console.warn('LLM 理由生成失败（回退模板）:', res.error)
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonFence(res.content))
  } catch {
    console.warn('LLM 理由返回非法 JSON（回退模板）')
    return null
  }

  const arr = (parsed as { reasons?: unknown } | null)?.reasons
  if (!Array.isArray(arr)) return null

  const map: Record<string, string> = {}
  for (const entry of arr) {
    const e = entry as { id?: unknown; reason?: unknown } | null
    if (typeof e?.id === 'string' && typeof e.reason === 'string' && e.reason.trim()) {
      map[e.id] = e.reason.trim().slice(0, LLM_REASON_MAX_LEN)
    }
  }

  // id 对不上（任一候选缺失或整体为空）→ 全部回退模板，避免理由张冠李戴
  const allMatched = items.every((it) => typeof map[it.id] === 'string')
  if (!allMatched) {
    console.warn('LLM 理由 id 未全部覆盖（回退模板）')
    return null
  }
  return map
}
