// ============================================================
// CI Enrich —— 批量 AI 富化（条目级分析，缓存复用）
//
// 回答"为什么受欢迎/什么结构/什么情绪"（条目级问题）。
// 一次 LLM 调用处理最多 8 条（批量，不是 8 次调用），只富化相关性 Top 8。
// 富化结果按 (platform, external_id) 落库——内容不变，分析不变，永久复用。
//
// 红线：web/news 源无评论数据，user_feedback 永远为 null，禁止 LLM 编造。
// ============================================================

import type { CIItem } from './types'
import { callDeepSeekChat, stripJsonFence } from '@/lib/llm'

/** 富化后的条目级分析字段 */
export interface EnrichedFields {
  opening_structure: string | null
  core_viewpoint: string | null
  emotion_type: string | null
  narrative_structure: string | null
  reference_value: string | null
}

const MAX_ENRICH = 8

function nullable(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim().slice(0, max)
  return t || null
}

/** 批量富化：失败时保留原始条目（ai_analysis = null），不阻塞主流程 */
export async function enrichItems(items: CIItem[]): Promise<CIItem[]> {
  const targets = items.slice(0, MAX_ENRICH)
  if (targets.length === 0) return items

  const idList = targets.map((t) => t.external_id)
  const enriched = await requestEnrichment(targets)

  return items.map((item) => {
    const hit = enriched.get(item.external_id)
    if (!hit) return item
    return {
      ...item,
      ai_analysis: {
        ...hit,
        user_feedback: null, // web/news 源无评论数据，硬编码 null（能力门控）
      },
    }
  })

  // —— 内部工具 ——
  function rebuildMap(pairs: Array<[string, EnrichedFields]>): Map<string, EnrichedFields> {
    return new Map(pairs)
  }

  async function requestEnrichment(batch: CIItem[]): Promise<Map<string, EnrichedFields>> {
    const input = batch.map((t) => ({
      external_id: t.external_id,
      platform: t.platform,
      title: t.title,
      excerpt: t.excerpt,
      published_at: t.published_at,
    }))
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await callDeepSeekChat({
          messages: [
            {
              role: 'system',
              content: [
                '你是内容分析器。给你一批网页/新闻搜索结果（可能是某个创作主题相关的市场内容），逐条分析它们对内容创作者的参考价值。',
                '只基于给定的 title/excerpt 文本分析，禁止编造文本中不存在的具体事实（数据、人名、事件细节）。',
                'excerpt 太短无法判断的字段输出 null，禁止硬编。',
                '',
                '每条输出以下字段：',
                '- opening_structure：开头结构（≤40字，如"疑问句开场+权威背书"）',
                '- core_viewpoint：核心观点（≤60字，概括其立场/结论）',
                '- emotion_type：主导情绪（2-8字，如"职业焦虑""乐观期待""愤怒"）',
                '- narrative_structure：叙事结构（≤40字，如"问题→分析→建议"）',
                '- reference_value：对创作者的参考价值（≤60字，如"可参考其数据引用方式"）',
                '',
                '硬性输出要求：只输出一个 JSON 对象，格式：',
                '{"items":[{"external_id":"...","opening_structure":"...","core_viewpoint":"...","emotion_type":"...","narrative_structure":"...","reference_value":"..."}]}',
                'items 必须覆盖输入的每一条（按 external_id 对应），禁止增删。',
              ].join('\n'),
            },
            {
              role: 'user',
              content: JSON.stringify({ items: input }),
            },
          ],
          temperature: 0.3,
          max_tokens: 2500,
          jsonMode: true,
        })
        if (!res.ok) {
          console.error('CI enrich 失败:', res.error)
          continue // 重试
        }

        const cleaned = stripJsonFence(res.content)
        const parsed = JSON.parse(cleaned) as { items?: unknown }
        if (!Array.isArray(parsed.items)) return new Map()

        const idSet = new Set(idList)
        const pairs: Array<[string, EnrichedFields]> = []
        for (const raw of parsed.items) {
          if (typeof raw !== 'object' || raw === null) continue
          const o = raw as Record<string, unknown>
          const id = typeof o.external_id === 'string' ? o.external_id : ''
          if (!idSet.has(id)) continue // 只接受输入中存在的 id
          pairs.push([
            id,
            {
              opening_structure: nullable(o.opening_structure, 60),
              core_viewpoint: nullable(o.core_viewpoint, 80),
              emotion_type: nullable(o.emotion_type, 20),
              narrative_structure: nullable(o.narrative_structure, 60),
              reference_value: nullable(o.reference_value, 80),
            },
          ])
        }
        return rebuildMap(pairs)
      } catch (e) {
        console.error(`CI enrich 异常（第 ${attempt + 1} 次）:`, e)
      }
    }
    return new Map()
  }
}
