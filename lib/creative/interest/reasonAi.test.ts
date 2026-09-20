// ============================================================
// WF6：generateAiReasons —— build 时批量 AI 推荐理由预制
//
// 请求路径零 LLM：理由在 build 步骤 14.5 一次性生成落库。
// 事实校验红线（spec 阶段7）：
//   - whyRecommend 必须复述真实事实（含 cluster_label），否则该条模板降级
//   - relatedKnowledge 只能从 S3 素材标题闭集中选（AI 不得编造素材）
//   - 无 facts 的候选（探索卡等）直接模板，不送 AI
//   - AI 整体失败：全部模板降级，绝不丢卡、绝不抛错
// ============================================================

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { generateAiReasons, buildReasonText, type AiReasonInput } from './reasonAi'

function aiPayloadFor(items: Array<Record<string, unknown>>) {
  return {
    choices: [{ message: { content: JSON.stringify({ reasons: items }) } }],
  }
}

function baseInput(over: Partial<AiReasonInput> = {}): AiReasonInput {
  return {
    title: 'AI 正在改变普通人的工作方式',
    clusterLabel: 'AI创业',
    facts: [
      { type: 'create', count: 4, cluster_label: 'AI创业' },
      { type: 'finalize', count: 2, cluster_label: 'AI创业' },
    ],
    gapReason: null,
    materialTitles: ['你的AI创业案例素材', '大厂裁员观察笔记'],
    ...over,
  }
}

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('generateAiReasons：AI 正常路径', () => {
  it('批量一次调用；AI 输出逐条透传，reason_source=ai；relatedKnowledge 裁剪为闭集子集', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify(
          aiPayloadFor([
            {
              core_question: '普通人该如何借力 AI 完成职业转型？',
              why_recommend: '你最近 4 篇作品都在讨论「AI创业」对个人发展的影响',
              creation_angle: '从普通人的职业选择切入，用你收藏的真实案例做论据',
              related_knowledge: ['你的AI创业案例素材', 'AI 编造的素材标题'],
            },
          ])
        ),
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const out = await generateAiReasons([baseInput()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      coreQuestion: '普通人该如何借力 AI 完成职业转型？',
      whyRecommend: '你最近 4 篇作品都在讨论「AI创业」对个人发展的影响',
      creationAngle: '从普通人的职业选择切入，用你收藏的真实案例做论据',
      relatedKnowledge: ['你的AI创业案例素材'], // 闭集外被剔除
      reasonSource: 'ai',
    })
  })

  it('无簇候选（facts 空）直接模板不送 AI；有簇候选正常送 AI', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify(
          aiPayloadFor([
            {
              core_question: 'q',
              why_recommend: '因为你在「AI创业」持续创作',
              creation_angle: 'a',
              related_knowledge: [],
            },
          ])
        ),
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const out = await generateAiReasons([
      baseInput({ clusterLabel: null, facts: [], gapReason: '探索性方向：基于你的兴趣扩展' }),
      baseInput(),
    ])
    // 只送 1 条给 AI（payload 不含探索卡）
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(sent.messages[1].content).not.toContain('探索性方向')
    expect(out[0]).toMatchObject({ reasonSource: 'template', coreQuestion: null })
    expect(out[0].whyRecommend).toContain('探索性方向')
    expect(out[1].reasonSource).toBe('ai')
  })
})

describe('generateAiReasons：事实校验与降级', () => {
  it('whyRecommend 不含 cluster_label → 该条模板降级（AI 幻觉拦截）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            aiPayloadFor([
              {
                core_question: 'q',
                why_recommend: '这个选题非常热门，全网都在讨论', // 无「AI创业」
                creation_angle: 'a',
                related_knowledge: [],
              },
            ])
          ),
          { status: 200 }
        )
      )
    )
    const out = await generateAiReasons([baseInput()])
    expect(out[0].reasonSource).toBe('template')
    expect(out[0].coreQuestion).toBeNull()
  })

  it('AI 返回条数不足 → 缺失条目模板兜底（保卡不丢卡）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            aiPayloadFor([
              { core_question: 'q1', why_recommend: '围绕「AI创业」的延续', creation_angle: 'a1', related_knowledge: [] },
            ])
          ),
          { status: 200 }
        )
      )
    )
    const out = await generateAiReasons([baseInput(), baseInput({ title: '第二张卡' })])
    expect(out).toHaveLength(2)
    expect(out[0].reasonSource).toBe('ai')
    expect(out[1].reasonSource).toBe('template')
  })

  it('AI 整体失败（网络错误/HTTP 错误/JSON 损坏）→ 全部模板，不抛错', async () => {
    for (const scenario of [
      () => Promise.reject(new Error('network down')),
      () => Promise.resolve(new Response('gateway timeout', { status: 502 })),
      () => Promise.resolve(new Response('not json at all', { status: 200 })),
    ]) {
      vi.stubGlobal('fetch', vi.fn(scenario))
      const out = await generateAiReasons([baseInput()])
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({
        reasonSource: 'template',
        coreQuestion: null,
        whyRecommend: null,
        creationAngle: null,
        relatedKnowledge: [],
      })
    }
  })

  it('未配置 DEEPSEEK_API_KEY → 直接全部模板，零网络调用', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const out = await generateAiReasons([baseInput()])
    expect(out[0].reasonSource).toBe('template')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('buildReasonText（从 route.ts 迁移复用）', () => {
  it('事实模板：create/finalize/save 计数 + gap_reason 拼接', () => {
    const s = buildReasonText({
      slot: 'core_gap',
      clusterCode: 'c1',
      evidence: {
        facts: [
          { type: 'create', count: 4, cluster_label: 'AI创业' },
          { type: 'finalize', count: 2, cluster_label: 'AI创业' },
          { type: 'save', count: 3, cluster_label: 'AI创业' },
        ],
        gap_reason: '你在「AI创业」关注但还未写过',
      },
    })
    expect(s).toContain('4 篇「AI创业」')
    expect(s).toContain('定稿 2 篇')
    expect(s).toContain('收藏 3 条')
    expect(s).toContain('关注但还未写过')
  })

  it('无 facts → 默认文案（与旧 route 行为一致）', () => {
    expect(buildReasonText({ slot: 'exploration', clusterCode: null, evidence: {} })).toBe(
      '基于你的创作兴趣推荐'
    )
  })
})
