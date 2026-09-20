// ============================================================
// Creator Interest Profile —— 簇命名（LLM 调用，带降级）
//
// 对新簇（未继承到 cluster_code 的）生成 label + summary + slug。
// 失败兜底：slug 用随机码 c_xxxx，label 用证据事件标题。
// ============================================================

import { cleanText } from './normalize'

export interface NamingResult {
  label: string
  summary: string
  slug: string
  keywords: string[]
}

const SYSTEM_PROMPT = [
  '你是兴趣标签师。给你一个语义簇的成员主题摘要，为这个簇起名。',
  '输出 JSON：{ label: "≤12字中文标签", summary: "≤100字描述该簇在关注什么", slug: "c_英文蛇形码", keywords: ["≤6个关键词"] }',
  'slug 规范：c_ 开头 + 小写英文+数字+下划线，总长 ≤30，如 c_ai_business。',
  '只输出 JSON，不要其他文字。',
].join('\n')

function randomSlug(): string {
  return 'c_' + Math.random().toString(36).slice(2, 8)
}

/**
 * 批量为新簇命名。一次 LLM 调用处理全部新簇。
 */
export async function batchNameClusters(
  newClusters: Array<{ tempId: string; topics: string[] }>
): Promise<Map<string, NamingResult>> {
  const results = new Map<string, NamingResult>()

  if (!newClusters.length) return results

  // 无 key 或只有 1 个簇时也走 LLM，但如果 API 未配置直接降级
  if (!process.env.DEEPSEEK_API_KEY) {
    for (const c of newClusters) {
      results.set(c.tempId, {
        label: c.topics[0]?.slice(0, 12) || '新兴趣',
        summary: '',
        slug: randomSlug(),
        keywords: [],
      })
    }
    return results
  }

  const userContent = newClusters
    .map((c, i) => `[${i + 1}] temp_id=${c.tempId} 主题摘要：${c.topics.slice(0, 5).join(' / ')}`)
    .join('\n')

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `为以下 ${newClusters.length} 个新簇命名：\n${userContent}` },
        ],
        temperature: 0.5,
        max_tokens: 800,
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      console.error('[interest] 簇命名 LLM 失败:', await res.text())
      for (const c of newClusters) {
        results.set(c.tempId, {
          label: c.topics[0]?.slice(0, 12) || '新兴趣',
          summary: '',
          slug: randomSlug(),
          keywords: [],
        })
      }
      return results
    }

    const data = await res.json()
    const text: string = data?.choices?.[0]?.message?.content ?? ''
    if (!text.trim()) throw new Error('空响应')

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const parsed = JSON.parse(cleaned)

    const arr: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.clusters)
        ? (parsed as Record<string, unknown[]>).clusters
        : [parsed]

    for (let i = 0; i < newClusters.length; i++) {
      const c = newClusters[i]
      const obj = (arr[i] ?? {}) as Record<string, unknown>
      const label = cleanText(obj.label, 20) || c.topics[0]?.slice(0, 12) || '新兴趣'
      const summary = cleanText(obj.summary, 200)
      let slug = cleanText(obj.slug, 30)
      if (!slug.startsWith('c_')) slug = randomSlug()
      const keywords = Array.isArray(obj.keywords)
        ? (obj.keywords as unknown[]).filter((x) => typeof x === 'string').slice(0, 6).map((x) => cleanText(x, 20))
        : []
      results.set(c.tempId, { label, summary, slug, keywords })
    }
    return results
  } catch (e) {
    console.error('[interest] 簇命名异常:', e)
    for (const c of newClusters) {
      results.set(c.tempId, {
        label: c.topics[0]?.slice(0, 12) || '新兴趣',
        summary: '',
        slug: randomSlug(),
        keywords: [],
      })
    }
    return results
  }
}
