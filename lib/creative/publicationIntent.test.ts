import { describe, it, expect } from 'vitest'
import {
  LADDER_RANK,
  computePublicationIntent,
  fetchIntentFacts,
  ladderOf,
  type ProjectIntentFacts,
} from './publicationIntent'

const NOW = new Date('2026-09-24T00:00:00Z')
const FRESH = '2026-09-20T00:00:00Z'

function p(over: Partial<ProjectIntentFacts> & { projectId: string }): ProjectIntentFacts {
  return {
    edited: false,
    liked: false,
    negative: false,
    finalized: false,
    published: false,
    lastActivityAt: FRESH,
    ...over,
  }
}

function run(projects: ProjectIntentFacts[]) {
  return computePublicationIntent({ projects, now: NOW })
}

describe('ladderOf 阶梯判定', () => {
  it('无任何正向信号 → unclaimed（L0）', () => {
    expect(ladderOf(p({ projectId: 'a' })).level).toBe('unclaimed')
  })

  it('仅有迭代投入 → polishing（L1）', () => {
    expect(ladderOf(p({ projectId: 'a', edited: true })).level).toBe('polishing')
  })

  it('点赞优先于打磨 → approved（L2）', () => {
    expect(ladderOf(p({ projectId: 'a', edited: true, liked: true })).level).toBe('approved')
  })

  it('定稿优先于点赞 → finalized（L3）', () => {
    expect(ladderOf(p({ projectId: 'a', liked: true, finalized: true })).level).toBe('finalized')
  })

  it('发布优先于定稿 → published（L4）', () => {
    expect(ladderOf(p({ projectId: 'a', finalized: true, published: true })).level).toBe('published')
  })

  it('negative 不参与定级：先定稿后删除仍是 finalized，但 negative=true', () => {
    const l = ladderOf(p({ projectId: 'a', finalized: true, negative: true }))
    expect(l.level).toBe('finalized')
    expect(l.negative).toBe(true)
  })
})

describe('computePublicationIntent 分数', () => {
  it('空输入 → 全零且不炸', () => {
    const r = run([])
    expect(r.counts.total).toBe(0)
    expect(r.intentScore).toBe(0)
    expect(r.confidence).toBe(0)
    expect(r.peakLevel).toBe('unclaimed')
  })

  it('全部未认领 → 0 分（分母诚实，不给安慰分）', () => {
    const r = run([p({ projectId: 'a' }), p({ projectId: 'b' }), p({ projectId: 'c' })])
    expect(r.intentScore).toBe(0)
    expect(r.rates.publish).toBe(0)
  })

  it('仅打磨未认可 → 0 分（投入不等于认可）', () => {
    const r = run([
      p({ projectId: 'a', edited: true }),
      p({ projectId: 'b', edited: true }),
      p({ projectId: 'c', edited: true }),
    ])
    expect(r.intentScore).toBe(0)
    expect(r.counts.polishing).toBe(3)
  })

  it('全部定稿 → 0.55（0.30 finalize + 0.25 approval，发布为 0）', () => {
    const r = run([
      p({ projectId: 'a', finalized: true }),
      p({ projectId: 'b', finalized: true }),
      p({ projectId: 'c', finalized: true }),
    ])
    expect(r.rates.finalize).toBe(1)
    expect(r.rates.approval).toBe(1)
    expect(r.rates.publish).toBe(0)
    expect(r.intentScore).toBe(0.55)
  })

  it('全部发布 → 满分 1（三级权重全中）', () => {
    const r = run([
      p({ projectId: 'a', published: true }),
      p({ projectId: 'b', published: true }),
      p({ projectId: 'c', published: true }),
    ])
    expect(r.intentScore).toBe(1)
    expect(r.peakLevel).toBe('published')
  })

  it('负向按乘法折扣而非减法：全定稿 + 半数删除 → 0.55 × 0.75', () => {
    const r = run([
      p({ projectId: 'a', finalized: true, negative: true }),
      p({ projectId: 'b', finalized: true }),
    ])
    // negativeRate = 0.5 → 1 - 0.5*0.5 = 0.75 → 0.55 * 0.75 = 0.4125 → 0.413
    expect(r.intentScore).toBe(0.413)
  })

  it('分数恒在 0-1 内（极端负向也不越界）', () => {
    const r = run([p({ projectId: 'a', negative: true })])
    expect(r.intentScore).toBeGreaterThanOrEqual(0)
    expect(r.intentScore).toBeLessThanOrEqual(1)
  })

  it('peakLevel 取达成过的最高级，不受低分项目拉低', () => {
    const r = run([
      p({ projectId: 'a' }),
      p({ projectId: 'b', edited: true }),
      p({ projectId: 'c', finalized: true }),
    ])
    expect(r.peakLevel).toBe('finalized')
  })
})

describe('置信度', () => {
  it('低样本（<3 项目）硬压上限 0.4：写了 2 篇都发也不给高分置信', () => {
    const r = run([p({ projectId: 'a', published: true }), p({ projectId: 'b', published: true })])
    expect(r.intentScore).toBe(1)
    expect(r.confidence).toBeLessThanOrEqual(0.4)
  })

  it('样本充足且新鲜 → 高置信', () => {
    const projects = Array.from({ length: 8 }, (_, i) =>
      p({ projectId: `p${i}`, published: true, lastActivityAt: FRESH })
    )
    const r = run(projects)
    expect(r.confidence).toBeGreaterThan(0.4)
  })

  it('长期不活跃 → 新鲜度拉低置信', () => {
    const stale = Array.from({ length: 8 }, (_, i) =>
      p({ projectId: `p${i}`, published: true, lastActivityAt: '2025-01-01T00:00:00Z' })
    )
    const staleReport = run(stale)
    const freshReport = run(
      Array.from({ length: 8 }, (_, i) =>
        p({ projectId: `p${i}`, published: true, lastActivityAt: FRESH })
      )
    )
    expect(staleReport.confidence).toBeLessThan(freshReport.confidence)
  })

  it('空样本置信度为 0', () => {
    expect(run([]).confidence).toBe(0)
  })
})

describe('fetchIntentFacts 降级', () => {
  it('项目查询失败 → 返回空数组，不抛错（指标绝不阻断主流程）', async () => {
    const fake = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: async () => ({ data: null, error: { message: 'boom' } }),
            }),
          }),
        }),
      }),
    }
    const out = await fetchIntentFacts(fake as never, 'user-1')
    expect(out).toEqual([])
  })

  it('事件/发布查询失败 → 已取到的项目仍然返回（部分维度缺失而非整体失败）', async () => {
    const fake = {
      from: (table: string) => {
        if (table === 'creative_projects') {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({
                    data: [{ id: 'x1', status: 'finalized', updated_at: FRESH }],
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        // creator_events / posts 都失败
        return {
          select: () => ({
            eq: () => ({
              order: () => ({ limit: async () => ({ data: null, error: { message: 'boom' } }) }),
              not: () => ({
                limit: async () => ({ data: null, error: { message: 'boom' } }),
              }),
            }),
          }),
        }
      },
    }
    const out = await fetchIntentFacts(fake as never, 'user-1')
    expect(out).toHaveLength(1)
    expect(out[0].finalized).toBe(true)
    expect(out[0].published).toBe(false)
  })
})

// ============================================================
// 孤儿发布证据（2026-09-24 实测发现的真实 bug）
//
// 真实库里观察到一个用户：posts 有带 source_project_id 的帖子（发布过），
// 但该项目已不在 creative_projects（多半被删）。旧实现 `if (f) f.published = true`
// 会把这条证据静默丢弃 → 该用户 publishRate 恒 0，明明发布过却被算成从未发布。
//
// 发布意愿一旦发生就不可撤销：帖子仍公开在广场、archive 快照仍在，
// 项目后续被清理不该抹掉这次发布。
// ============================================================
describe('fetchIntentFacts：发布证据不随项目删除丢失', () => {
  function clientWith(
    projects: Array<{ id: string; status: string; updated_at: string }>,
    events: unknown[],
    posts: Array<{ source_project_id: string; created_at: string }>
  ) {
    return {
      from: (table: string) => {
        if (table === 'creative_projects') {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({ limit: async () => ({ data: projects, error: null }) }),
              }),
            }),
          }
        }
        if (table === 'creator_events') {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({ limit: async () => ({ data: events, error: null }) }),
              }),
            }),
          }
        }
        return {
          select: () => ({
            eq: () => ({
              not: () => ({ limit: async () => ({ data: posts, error: null }) }),
            }),
          }),
        }
      },
    }
  }

  it('帖子仍在但项目已删 → 孤儿发布计入分子分母', async () => {
    const out = await fetchIntentFacts(
      clientWith([{ id: 'alive', status: 'active', updated_at: FRESH }], [], [
        { source_project_id: 'deleted-proj', created_at: FRESH },
      ]) as never,
      'u1'
    )
    expect(out).toHaveLength(2) // 存活项目 + 孤儿项目
    const orphan = out.find((f) => f.projectId === 'deleted-proj')
    expect(orphan?.published).toBe(true)
    expect(orphan?.finalized).toBe(false) // 项目已消失，无从得知，保守处理
  })

  it('同一项目多次发布 → 只计一次，不重复建孤儿', async () => {
    const out = await fetchIntentFacts(
      clientWith([{ id: 'alive', status: 'active', updated_at: FRESH }], [], [
        { source_project_id: 'alive', created_at: FRESH },
        { source_project_id: 'alive', created_at: FRESH },
      ]) as never,
      'u1'
    )
    expect(out).toHaveLength(1)
    expect(out[0].published).toBe(true)
  })

  it('修复效果：孤儿发布让 publishRate 从 0 变正数', () => {
    // 修复前：孤儿被丢弃 → 只有 2 个存活项目、0 次发布
    const before = run([
      p({ projectId: 'a' }),
      p({ projectId: 'b' }),
    ])
    // 修复后：孤儿项目补进事实包，它存在过且发布过
    const after = run([
      p({ projectId: 'a' }),
      p({ projectId: 'b' }),
      p({ projectId: 'deleted-proj', published: true }),
    ])
    expect(before.counts.published).toBe(0)
    expect(after.counts.published).toBe(1)
    expect(after.intentScore).toBeGreaterThan(before.intentScore)
  })
})

// ============================================================
// 真实形态基线图
//
// 数据来源：2026-09-24 用 service key 对真实库做的一次性诊断
//   （creative_projects / posts 因权限不足查不到，故由
//    generation_history 的 `{projectId}::v{N}` 复合主键反推）：
//     6 用户 / 74 项目 / 89 版本行，每用户项目数中位 6，每项目版本数中位 1
//     事件：work_generate 52 / work_delete 17 / work_finalize 5 / feedback_like 4
//
// 这两个用例的用途不是校准阈值（阈值只能由真实发布率校准，而 posts 无权限），
// 而是回答一个更关键的问题：**指标能不能检测出改善？**
// 如果一个指标在「用户创作完成度明显变好」时数字不动，它就是无用的。
// ============================================================
describe('真实形态基线图', () => {
  /** 按真实形态构造：74 项目 / 5 定稿 / 4 点赞 / 17 删除 / 0 发布 */
  function realShape() {
    const out: ProjectIntentFacts[] = []
    for (let i = 0; i < 5; i++) out.push(p({ projectId: `fin${i}`, finalized: true }))
    for (let i = 0; i < 4; i++) out.push(p({ projectId: `like${i}`, liked: true }))
    for (let i = 0; i < 17; i++) out.push(p({ projectId: `del${i}`, negative: true }))
    for (let i = 0; i < 48; i++) out.push(p({ projectId: `idle${i}` }))
    return out
  }

  it('当前真实基线 ≈ 0.045（定稿 7% / 删除 23% / 发布 0%）', () => {
    const r = run(realShape())
    expect(r.counts.total).toBe(74)
    expect(r.counts.finalized).toBe(5)
    expect(r.counts.negative).toBe(17)
    // 低分是真实反映，不是指标缺陷：74 次生成里只有 5 次走到定稿
    expect(r.intentScore).toBe(0.045)
  })

  it('改善场景（定稿升至 30%、发布 9%、删除降至 11%）→ 分数显著上升', () => {
    const improved: ProjectIntentFacts[] = []
    for (let i = 0; i < 7; i++)
      improved.push(p({ projectId: `pub${i}`, finalized: true, published: true }))
    for (let i = 0; i < 15; i++) improved.push(p({ projectId: `fin${i}`, finalized: true }))
    for (let i = 0; i < 10; i++) improved.push(p({ projectId: `like${i}`, liked: true }))
    for (let i = 0; i < 8; i++) improved.push(p({ projectId: `del${i}`, negative: true }))
    for (let i = 0; i < 34; i++) improved.push(p({ projectId: `idle${i}` }))

    const base = run(realShape())
    const next = run(improved)
    expect(next.counts.total).toBe(74)
    expect(next.intentScore).toBe(0.227)
    // 关键断言：指标对改善敏感，否则它无法用于追踪「越来越懂创作者」
    expect(next.intentScore).toBeGreaterThan(base.intentScore * 3)
  })
})

describe('LADDER_RANK 单调性', () => {
  it('阶梯序号严格递增', () => {
    const order = ['unclaimed', 'polishing', 'approved', 'finalized', 'published'] as const
    const ranks = order.map((k) => LADDER_RANK[k])
    expect(ranks).toEqual([0, 1, 2, 3, 4])
  })
})
