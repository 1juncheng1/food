import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  contentChanged,
  normalizeAlignmentReport,
  precheckAlignment,
  verdictOf,
  verifyFeedbackAlignment,
  type AlignmentInput,
} from './feedbackAlignment'

// ── 固定样本 ────────────────────────────────────────────────

const BEFORE = '开头是一段平铺直叙的背景介绍。中间讲了三个案例。结尾做了一个简单总结。'
const AFTER = '开头改成了一个尖锐的冲突场景。中间讲了三个案例。结尾做了一个升华总结。'

function input(over: Partial<AlignmentInput> = {}): AlignmentInput {
  return {
    freeText: '开头不够吸引人',
    intentLabel: '重构开头',
    targets: ['开头冲突', '结尾升华'],
    preserveItems: ['三个案例', '故事主题'],
    before: BEFORE,
    after: AFTER,
    ...over,
  }
}

/** mock DeepSeek：content 为模型返回的 JSON 字符串 */
function mockLlm(content: string) {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => content,
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

// ── contentChanged ─────────────────────────────────────────

describe('contentChanged', () => {
  it('内容不同 → true', () => {
    expect(contentChanged(BEFORE, AFTER)).toBe(true)
  })

  it('内容相同 → false', () => {
    expect(contentChanged(BEFORE, BEFORE)).toBe(false)
  })

  it('只有换行被折叠为空格的差异不算改动', () => {
    // 归一化后两者都是「第一段。 第二段。」——纯排版差异不代表内容被改过
    expect(contentChanged('第一段。\n第二段。', '第一段。 第二段。')).toBe(false)
  })

  it('删除分隔符空格属于实质改动', () => {
    expect(contentChanged('第一段。 第二段。', '第一段。第二段。')).toBe(true)
  })
})

// ── verdictOf ──────────────────────────────────────────────

describe('verdictOf：结论由代码裁定，不采信 LLM 自评', () => {
  const hit = (h: boolean) => ({ target: 't', hit: h, evidence: '' })

  it('全命中 + 高分 + 保持项完好 → aligned', () => {
    expect(verdictOf(90, [hit(true), hit(true)], [{ item: 'p', intact: true, note: '' }])).toBe('aligned')
  })

  it('保持项被破坏时，即使全命中高分也最多 partial', () => {
    expect(verdictOf(95, [hit(true)], [{ item: 'p', intact: false, note: '' }])).toBe('partial')
  })

  it('有修改点未命中 → 即使高分也不算 aligned', () => {
    expect(verdictOf(88, [hit(true), hit(false)], [])).toBe('partial')
  })

  it('中等分数 → partial', () => {
    expect(verdictOf(55, [hit(true)], [])).toBe('partial')
  })

  it('低分 → off', () => {
    expect(verdictOf(20, [hit(false)], [])).toBe('off')
  })

  it('无修改点可比时不给 aligned（无从判定）', () => {
    expect(verdictOf(100, [], [])).toBe('partial')
  })
})

// ── precheckAlignment ──────────────────────────────────────

describe('precheckAlignment', () => {
  it('新版本与上一版完全一致 → 直接判 off（不浪费 LLM）', () => {
    const r = precheckAlignment(input({ after: BEFORE }))
    expect(r).not.toBeNull()
    expect(r!.verdict).toBe('off')
    expect(r!.score).toBe(0)
    expect(r!.addressed.every((a) => !a.hit)).toBe(true)
  })

  it('内容有变 → 返回 null，交给 LLM 判定', () => {
    expect(precheckAlignment(input())).toBeNull()
  })
})

// ── normalizeAlignmentReport ───────────────────────────────

describe('normalizeAlignmentReport', () => {
  it('正常输出 → 逐条保留命中情况与保持项', () => {
    const r = normalizeAlignmentReport(
      {
        score: 88,
        addressed: [
          { target: '开头冲突', hit: true, evidence: '新开头第 2 句改为设问' },
          { target: '结尾升华', hit: false, evidence: '结尾未改' },
        ],
        preserved: [{ item: '三个案例', intact: true, note: '案例原文保留' }],
        summary: '开头已改，结尾未动。',
      },
      { targets: ['开头冲突', '结尾升华'], preserveItems: ['三个案例', '故事主题'] }
    )
    expect(r).not.toBeNull()
    expect(r!.score).toBe(88)
    expect(r!.verdict).toBe('partial') // 有一条未命中
    expect(r!.addressed[1].hit).toBe(false)
    expect(r!.preserved[0].intact).toBe(true)
  })

  it('LLM 漏写 target → 按序回落到输入的修改点', () => {
    const r = normalizeAlignmentReport(
      { score: 90, addressed: [{ hit: true, evidence: 'x' }] },
      { targets: ['开头冲突'], preserveItems: [] }
    )
    expect(r!.addressed[0].target).toBe('开头冲突')
  })

  it('一条修改点都没核对 → 返回 null（空壳结论对用户无价值）', () => {
    expect(
      normalizeAlignmentReport({ score: 50 }, { targets: ['开头冲突'], preserveItems: [] })
    ).toBeNull()
  })

  it('score 越界 → 夹取到 0-100', () => {
    const r = normalizeAlignmentReport(
      { score: 300, addressed: [{ target: 't', hit: true }] },
      { targets: ['t'], preserveItems: [] }
    )
    expect(r!.score).toBe(100)
  })

  it('score 非法 → 回落 50', () => {
    const r = normalizeAlignmentReport(
      { score: 'abc', addressed: [{ target: 't', hit: true }] },
      { targets: ['t'], preserveItems: [] }
    )
    expect(r!.score).toBe(50)
  })

  it('保持项缺失 intact 视为完好（默认不冤枉一次改动）', () => {
    const r = normalizeAlignmentReport(
      { score: 80, addressed: [{ target: 't', hit: true }], preserved: [{ item: '主题' }] },
      { targets: ['t'], preserveItems: ['主题'] }
    )
    expect(r!.preserved[0].intact).toBe(true)
  })
})

// ── verifyFeedbackAlignment ────────────────────────────────

describe('verifyFeedbackAlignment', () => {
  it('LLM 正常返回 → 输出报告', async () => {
    mockLlm(
      JSON.stringify({
        score: 85,
        addressed: [
          { target: '开头冲突', hit: true, evidence: '新开头直接抛出冲突' },
          { target: '结尾升华', hit: true, evidence: '结尾增加价值升华' },
        ],
        preserved: [{ item: '三个案例', intact: true, note: '案例未被删改' }],
        summary: '两处修改都已落实。',
      })
    )
    const r = await verifyFeedbackAlignment(input())
    expect(r).not.toBeNull()
    expect(r!.verdict).toBe('aligned')
    expect(r!.addressed).toHaveLength(2)
  })

  it('内容没变时直接出 off 报告，且不调用 LLM', async () => {
    const fetchMock = mockLlm('{}')
    const r = await verifyFeedbackAlignment(input({ after: BEFORE }))
    expect(r!.verdict).toBe('off')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('LLM 失败 → 返回 null（校验是增强，不阻塞主流程）', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => 'error' })))
    expect(await verifyFeedbackAlignment(input())).toBeNull()
  })

  it('LLM 返回坏 JSON → 返回 null', async () => {
    mockLlm('这不是 JSON')
    expect(await verifyFeedbackAlignment(input())).toBeNull()
  })

  it('缺少必要输入（无反馈原文/无前一版/无新版本）→ 返回 null', async () => {
    const fetchMock = mockLlm('{}')
    expect(await verifyFeedbackAlignment(input({ freeText: '' }))).toBeNull()
    expect(await verifyFeedbackAlignment(input({ before: '' }))).toBeNull()
    expect(await verifyFeedbackAlignment(input({ after: '' }))).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
