// ============================================================
// reasons —— 模板理由 + LLM 批量理由（AC-6/AC-8）
//
// LLM 三条失败形态（HTTP 非 2xx / 坏 JSON / id 对不上 / 超时）→ 返回 null，
// 调用方整体回退模板；成功路径全程只发 1 次 DeepSeek 请求。
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildTemplateReason,
  generateLlmReasons,
  SELECTED_REASON,
} from './reasons'

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('buildTemplateReason：字段缺失分段省略', () => {
  it('全字段：相似度 + 类型 + 关联主题（相似度四舍五入）', () => {
    expect(
      buildTemplateReason({
        similarity: 0.824,
        materialType: '数据',
        relatedTopics: ['创业', '增长', '融资'],
      })
    ).toBe('与主题语义相似度 82%；类型：数据；关联主题：创业、增长、融资')
  })

  it('关联主题最多展示 3 个', () => {
    const reason = buildTemplateReason({
      similarity: 0.9,
      materialType: '观点',
      relatedTopics: ['A', 'B', 'C', 'D'],
    })
    expect(reason).not.toContain('D')
  })

  it('无类型无主题 → 退化为只有相似度', () => {
    expect(
      buildTemplateReason({ similarity: 0.56, materialType: null, relatedTopics: null })
    ).toBe('与主题语义相似度 56%')
  })

  it('related_topics 为空数组/含空白 → 视为无主题段', () => {
    expect(
      buildTemplateReason({ similarity: 0.7, materialType: '案例', relatedTopics: [] })
    ).toBe('与主题语义相似度 70%；类型：案例')
    expect(
      buildTemplateReason({ similarity: 0.7, materialType: null, relatedTopics: ['  '] })
    ).toBe('与主题语义相似度 70%')
  })

  it('selected 固定文案', () => {
    expect(SELECTED_REASON).toBe('用户主动选择')
  })
})

const items = [
  { id: 'm1', content: '某 SaaS 公司年增长 300% 的案例', materialType: '数据' as const },
  { id: 'm2', content: '创业者要关注单位经济模型', materialType: '观点' as const },
]

function llmResponse(reasons: unknown) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reasons }) } }] }),
    { status: 200 }
  )
}

describe('generateLlmReasons（AC-8：最多 1 次批量调用）', () => {
  it('成功：只调 1 次 fetch，逐条 id 映射且理由裁剪 40 字', async () => {
    const longReason = '很'.repeat(60)
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        llmResponse([
          { id: 'm1', reason: '同为增长阶段的真实数据，可支撑你的论点' },
          { id: 'm2', reason: longReason },
        ])
      )
    vi.stubGlobal('fetch', fetchMock)

    const map = await generateLlmReasons('创业公司如何增长', items)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(map).not.toBeNull()
    expect(map?.m1).toBe('同为增长阶段的真实数据，可支撑你的论点')
    expect(map?.m2).toHaveLength(40)

    // prompt 中携带 topic 与每条素材内容前 300 字、temperature 0.2
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.temperature).toBe(0.2)
    expect(body.max_tokens).toBe(600)
    expect(init.body as string).toContain('创业公司如何增长')
    expect(init.body as string).toContain('单位经济模型')
  })

  it('空候选 → 不发请求，返回空映射', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const map = await generateLlmReasons('topic', [])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(map).toEqual({})
  })

  it('HTTP 非 2xx → null（回退模板）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 500 })))
    expect(await generateLlmReasons('topic', items)).toBeNull()
  })

  it('坏 JSON → null（回退模板）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: '不是JSON' } }] }), {
          status: 200,
        })
      )
    )
    expect(await generateLlmReasons('topic', items)).toBeNull()
  })

  it('markdown 代码块包裹的合法 JSON → 正常解析', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '```json\n' +
                    JSON.stringify({
                      reasons: [
                        { id: 'm1', reason: 'r1' },
                        { id: 'm2', reason: 'r2' },
                      ],
                    }) +
                    '\n```',
                },
              },
            ],
          }),
          { status: 200 }
        )
      )
    )
    const map = await generateLlmReasons('topic', items)
    expect(map).toEqual({ m1: 'r1', m2: 'r2' })
  })

  it('id 对不上（缺 m2）→ null（避免张冠李戴，整体回退）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        llmResponse([{ id: 'm1', reason: '只有一条' }, { id: 'mX', reason: '陌生 id' }])
      )
    )
    expect(await generateLlmReasons('topic', items)).toBeNull()
  })

  it('AbortError（8s 超时触发）→ null 不抛错', async () => {
    // 即时模拟 controller.abort()：fetch 监听 signal 的 abort 事件后 reject
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted')
              err.name = 'AbortError'
              reject(err)
            })
            queueMicrotask(() => init.signal?.dispatchEvent(new Event('abort')))
          })
      )
    )
    await expect(generateLlmReasons('topic', items)).resolves.toBeNull()
  })
})
