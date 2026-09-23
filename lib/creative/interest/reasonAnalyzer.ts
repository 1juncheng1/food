// ============================================================
// Creator Interest Profile —— 行为原因批解释（LLM 调用，带降级）
//
// DeepSeek JSON 数组模式批量处理；失败置 interpret_status=failed，不阻断 build。
// 复用项目成熟范式：fetch + response_format json_object + normalize 清洗。
// ============================================================

import { INTERPRET_BATCH_SIZE, INTERPRET_WINDOW_DAYS, RATIONALE_MAX } from './config'
import { cleanText } from './normalize'
import type { EngineEvent, ReasonCode, ReasonInterpretation } from './types'
import { llmTimeoutSignal } from '@/lib/llm'

const PROMPT_VERSION = 'behavior-reason-v1'

const SYSTEM_PROMPT = [
  '你是创作者行为分析师。给你一批创作者的近期行为，逐条分析每个行为背后的真实原因。',
  '只基于给定的信息分析，禁止编造。',
  '原因码必须从以下选择：genuine_interest / testing_feature / narrative_research / work_assignment / social_follow / accidental / other',
  '每个行为输出多个原因码及概率（概率之和约等于 1），一个 primary_reason（概率最高的），以及 ≤80 字的 rationale 说明。',
  '输出一个 JSON 数组，每个元素含 { event_id, reasons: [{code, probability}], rationale }。',
  '只输出 JSON 数组，不要任何其他文字。',
].join('\n')

export interface InterpretResult {
  eventId: string
  interpretation: ReasonInterpretation | null
}

/**
 * 批量解释低频高价值事件的行为原因。
 * 输入事件应已过滤为 needsInterpret + interpret_status=pending + 近 90 天。
 */
export async function batchInterpret(
  events: EngineEvent[],
  clusterLabels: string[]
): Promise<InterpretResult[]> {
  if (!events.length) return []
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('[interest] DEEPSEEK_API_KEY 未配置，跳过原因解释')
    return events.map((e) => ({ eventId: e.id, interpretation: null }))
  }

  const batch = events.slice(0, INTERPRET_BATCH_SIZE)

  const userBlocks = batch.map((e, i) => {
    const topic = (e as EngineEvent & { _topic?: string })._topic ?? '（无主题信息）'
    const clusters = clusterLabels.length ? `用户既有兴趣方向：${clusterLabels.join('、')}` : '（新用户，暂无既有兴趣）'
    const age = Math.round((Date.now() - Date.parse(e.occurredAt)) / 86_400_000)
    return `[${i + 1}] event_id=${e.id} 行为=${e.type} 对象=${e.targetType} 主题="${topic}" 发生时间=${age}天前 ${clusters}`
  })

  const userContent = [
    `待分析 ${batch.length} 条行为：`,
    ...userBlocks,
    '\n请逐条输出原因分析 JSON 数组。',
  ].join('\n')

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: llmTimeoutSignal(1200),
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.2,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      console.error('[interest] 原因解释 LLM 失败:', await res.text())
      return batch.map((e) => ({ eventId: e.id, interpretation: null }))
    }

    const data = await res.json()
    const text: string = data?.choices?.[0]?.message?.content ?? ''
    if (!text.trim()) return batch.map((e) => ({ eventId: e.id, interpretation: null }))

    // 防御：个别情况包 ```json
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const parsed = JSON.parse(cleaned)

    // 支持 { results: [...] } 或 [...] 两种包装
    const arr: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.results)
        ? (parsed as Record<string, unknown[]>).results
        : []

    const byId = new Map<string, InterpretResult>()
    for (const e of batch) byId.set(e.id, { eventId: e.id, interpretation: null })

    for (const item of arr) {
      const obj = item as Record<string, unknown>
      const eventId = String(obj.event_id ?? '')
      const result = byId.get(eventId)
      if (!result) continue

      const reasons = Array.isArray(obj.reasons) ? obj.reasons : []
      const validReasons: Array<{ code: ReasonCode; probability: number }> = []
      for (const r of reasons) {
        const ro = r as Record<string, unknown>
        const code = String(ro.code ?? '') as ReasonCode
        const p = Number(ro.probability)
        if (!code || !Number.isFinite(p) || p <= 0) continue
        validReasons.push({ code, probability: Math.min(1, p) })
      }
      // 概率校验：和偏差 >0.15 视为该条失败
      const sum = validReasons.reduce((s, r) => s + r.probability, 0)
      if (Math.abs(sum - 1) > 0.15) {
        continue // 保留 null，下期可重试
      }

      result.interpretation = {
        reasons: validReasons,
        ...(typeof obj.rationale === 'string'
          ? { rationale: cleanText(obj.rationale, RATIONALE_MAX) }
          : {}),
      }
    }

    return [...byId.values()]
  } catch (e) {
    console.error('[interest] 原因解释异常:', e)
    return batch.map((ev) => ({ eventId: ev.id, interpretation: null }))
  }
}

export function reasonWindowFilter(events: EngineEvent[]): EngineEvent[] {
  const cutoff = Date.now() - INTERPRET_WINDOW_DAYS * 86_400_000
  return events.filter((e) => {
    const t = Date.parse(e.occurredAt)
    return Number.isFinite(t) && t >= cutoff
  })
}

export { PROMPT_VERSION }
