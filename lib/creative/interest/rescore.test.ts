// ============================================================
// 在线重排（rescore.ts）—— RULE v5 的回归锁
//
// 这个文件的存在理由只有一个：**防止在线重排与离线打分漂移**。
// 只要有人改动 ranking.scoreCandidate 而不同步 rescore 的特征抽取，
// 同一张卡在"刚入库"和"下一次请求"会拿到两个分 —— 这正是 v4 之前
// 「同一队列两把尺子混排」的原形态。下面的第 1 组测试是它的防盗门禁。
// ============================================================

import { describe, expect, it } from 'vitest'
import {
  applyRescore,
  buildRankingFeatures,
  buildRescoreContext,
  parseRankingFeatures,
  rescoreRow,
  sortByScore,
  type RescoreContext,
  type RescoreableRow,
} from './rescore'
import { RANKING_VERSION } from './config'
import { exposureFatigueFactor } from './engagement'
import { scoreCandidate, recentBehaviorCentroid, tasteFactorFor } from './ranking'
import type { TasteEntry } from './ranking'
import type { TrendDirection } from './types'
import type { RescoreCluster } from './rescore'

const UNIT_X = [1, 0, 0, 0]
const UNIT_Y = [0, 1, 0, 0]

/**
 * 造一个簇上下文项。trend 的参数化必须落在受控枚举上——正因为 rescore 对脏数据
 * 一律按 null 处理（稳退化），测试里手写字面量会静默变成"没有趋势信号"而照样通过。
 */
function aCluster(
  code: string,
  centroid: number[],
  opts: { trend?: TrendDirection | null; lastSeenAt?: string } = {}
): RescoreCluster {
  return {
    code,
    centroid,
    weight: 1,
    lastSeenAt: opts.lastSeenAt ?? '2026-09-25T00:00:00.000Z',
    trend: opts.trend ?? 'stable',
  }
}

/** 一张可参与重排的卡（cluster_code 需命中 ctx.clusters 才有簇维度） */
function makeCard(over: Partial<RescoreableRow> = {}): RescoreableRow {
  return {
    id: 'card-1',
    cluster_code: 'c_a',
    slot: 'core_gap',
    source: 'own_inspiration',
    score: 0.5,
    score_breakdown: null,
    embedding: UNIT_X,
    ranking_features: buildRankingFeatures({ quality: 0.8, tagOverlap: 1, knowledge: null }),
    ...over,
  }
}

function baseContext(nowIso = '2026-09-25T00:00:00.000Z'): RescoreContext {
  return buildRescoreContext({
    clusters: [aCluster('c_a', UNIT_X, { lastSeenAt: nowIso })],
    now: new Date(nowIso),
  })
}

describe('rescore：与离线同源（防盗门禁）', () => {
  it('同一张卡、同一时刻，在线重排的分 == 离线 scoreCandidate 算出的分', () => {
    const nowIso = '2026-09-25T00:00:00.000Z'
    const ctx = baseContext(nowIso)

    // 离线口径（builder/refill 采味的同一套调用）
    const offline = scoreCandidate({
      candidate: {
        source: 'own_inspiration',
        slot: 'core_gap',
        title: 'T',
        description: 'D',
        topic: 'X',
        formHint: '其他',
        embedding: UNIT_X,
        clusterCode: 'c_a',
        contentValue: 0.8,
        marketRefs: null,
      },
      semanticSimilarity: 1,
      trend: 'stable',
      daysSinceLastInCluster: 0,
      tagOverlapRatio: 1,
      recentSimilarity: 1,
      knowledgeScore: null,
      tasteFactor: 1,
    })

    const online = rescoreRow(makeCard(), ctx)
    expect(online).not.toBeNull()
    expect(online!.score).toBe(offline.score)
    expect(online!.breakdown).toEqual(offline.breakdown)
  })
})

describe('rescore：这是修正了什么', () => {
  it('C-1 时间流逝后 recentBehavior 跟着掉 —— 卡不再顶着 build 时刻的分', () => {
    // 同一张卡、同一画像，只有"今天是几号"在变。这正是离线算死时抓不到的那部分。
    const now = new Date('2026-09-25T00:00:00.000Z')
    const card = makeCard()

    const fresh = rescoreRow(
      card,
      buildRescoreContext({
        clusters: [aCluster('c_a', UNIT_X, { lastSeenAt: '2026-09-25T00:00:00.000Z' })],
        now,
      })
    )!
    // 该簇最近一条行为退到 20 天前 → 落在 RECENCY_LADDER 的下一级阶梯
    const stale = rescoreRow(
      card,
      buildRescoreContext({
        clusters: [aCluster('c_a', UNIT_X, { lastSeenAt: '2026-09-05T00:00:00.000Z' })],
        now,
      })
    )!

    expect(fresh.breakdown.recentBehavior).toBe(0.95)
    expect(stale.breakdown.recentBehavior).toBe(0.5)
    expect(stale.score).toBeLessThan(fresh.score)
  })

  it('C-2 ✕ 的口味惩罚立刻落到存量卡上（不只是隐藏这一张）', () => {
    const card = makeCard()
    const now = new Date('2026-09-25T00:00:00.000Z')
    const entry: TasteEntry = { penalty: 0.6, reason: 'not_my_direction' }
    const clean = buildRescoreContext({
      clusters: [aCluster('c_a', UNIT_X)],
      tasteByCluster: new Map<string, TasteEntry>(),
      now,
    })
    const penalized = buildRescoreContext({
      clusters: [aCluster('c_a', UNIT_X)],
      tasteByCluster: new Map<string, TasteEntry>([['c_a', entry]]),
      now,
    })

    // 惩罚乘在最外层，必然严格小于未惩罚
    expect(rescoreRow(card, penalized)!.score).toBeLessThan(rescoreRow(card, clean)!.score)
    // 且与 ranking.tasteFactorFor 求值同源（不重跳一遍算式）
    expect(rescoreRow(card, penalized)!.breakdown.taste).toBe(
      tasteFactorFor(entry, 'core_gap')
    )
  })

  it('C-2b 口味惩罚是簇级的：同簇一起掉，别簇不受牵连', () => {
    const tasteMap = new Map<string, TasteEntry>([
      ['c_a', { penalty: 0.5, reason: null }],
    ])
    const clusters = [aCluster('c_a', UNIT_X), aCluster('c_b', UNIT_Y)]
    const now = new Date('2026-09-25T00:00:00.000Z')
    const clean = buildRescoreContext({ clusters, now })
    const dirty = buildRescoreContext({ clusters, tasteByCluster: tasteMap, now })

    const inClusterA = makeCard({ embedding: UNIT_X })
    const inClusterB = makeCard({ id: 'card-2', cluster_code: 'c_b', embedding: UNIT_Y })

    expect(rescoreRow(inClusterA, dirty)!.score).toBeLessThan(rescoreRow(inClusterA, clean)!.score)
    expect(rescoreRow(inClusterB, dirty)!.score).toBe(rescoreRow(inClusterB, clean)!.score)
  })

  it('质心漂移：同一张卡对着新质心会拿到不同的语义分', () => {
    const card = makeCard()
    const now = new Date('2026-09-25T00:00:00.000Z')
    const before = rescoreRow(card, buildRescoreContext({ clusters: [aCluster('c_a', UNIT_X)], now }))!
    const after = rescoreRow(card, buildRescoreContext({ clusters: [aCluster('c_a', UNIT_Y)], now }))!
    expect(after.breakdown.interestMatch).toBeLessThan(before.breakdown.interestMatch)
  })
})

describe('rescore：不可重排的行必须安全退回', () => {
  it('缺 ranking_features（迁移 0018 未执行前的旧卡）→ null', () => {
    const card = makeCard({ ranking_features: undefined })
    expect(rescoreRow(card, baseContext())).toBeNull()
  })

  it('features 版本落后 → null（宁可退回旧分，也不拿旧特征喂新公式）', () => {
    const card = makeCard({
      ranking_features: {
        ranking_version: 'interest-ranking-v0',
        quality: 0.8,
        tagOverlap: 1,
        knowledge: null,
      },
    })
    expect(rescoreRow(card, baseContext())).toBeNull()
  })

  it('features 字段畸形（字符串当数字）→ null', () => {
    const card = makeCard({
      ranking_features: { ranking_version: RANKING_VERSION, quality: 'high', tagOverlap: 1 },
    })
    expect(rescoreRow(card, baseContext())).toBeNull()
  })

  it('parseRankingFeatures 正常识别当前版本并把数值截断到 [0,1]', () => {
    const f = parseRankingFeatures({
      ranking_version: RANKING_VERSION,
      quality: 1.7,
      tagOverlap: -0.2,
      knowledge: 0.5,
    })
    expect(f).toEqual({ ranking_version: RANKING_VERSION, quality: 1, tagOverlap: 0, knowledge: 0.5 })
  })

  it('pgvector 字符串形态的 embedding 也能解析（PostgREST 返回 "[...]"）', () => {
    const ctx = baseContext()
    const fromString = rescoreRow(makeCard({ embedding: '[1,0,0,0]' }), ctx)!
    const fromArray = rescoreRow(makeCard({ embedding: UNIT_X }), ctx)!
    expect(fromString.score).toBe(fromArray.score)
  })
})

describe('applyRescore：排序与降级', () => {
  it('按重排后的 score 倒序，同分按 id 升序（确定性）', () => {
    const rows = [
      makeCard({ id: 'b', score: 0.9 }),
      makeCard({ id: 'a', score: 0.1 }),
    ]
    const sorted = applyRescore(rows, baseContext())
    // 两张卡完全同质 → 重排后同分 → 按 id 升序
    expect(sorted.map((r) => r.id)).toEqual(['a', 'b'])
    expect(sorted[0].score).toBe(sorted[1].score)
  })

  it('不可重排的旧卡保留库 score，并与新卡同批返回（不丢卡）', () => {
    const legacy = makeCard({ id: 'legacy', ranking_features: undefined, score: 0.42 })
    const modern = makeCard({ id: 'modern' })
    const out = applyRescore([legacy, modern], baseContext())
    expect(out).toHaveLength(2)
    expect(out.find((r) => r.id === 'legacy')!.score).toBe(0.42)
  })

  it('上下文为 null（簇查询失败）→ 原样返回，不抛不丢', () => {
    const rows = [makeCard({ id: 'x', score: 0.7 })]
    expect(applyRescore(rows, null)).toBe(rows)
  })

  it('sortByScore 稳定同序', () => {
    const rows = [
      { id: 'z', score: 0.5 },
      { id: 'a', score: 0.5 },
      { id: 'm', score: 0.9 },
    ]
    expect(sortByScore(rows).map((r) => r.id)).toEqual(['m', 'a', 'z'])
  })
})

describe('applyRescore：曝光—反馈闭环', () => {
  // 两张同质的卡：唯一差别是曝光历史。闭环必须能把"看腻的那张"翻下去。
  const ctxWith = (rows: Array<Record<string, unknown>>) =>
    buildRescoreContext({
      clusters: [aCluster('c_a', UNIT_X)],
      engagementRows: rows,
      now: new Date('2026-09-25T00:00:00.000Z'),
    })

  const repeat = (n: number, id: string) =>
    Array.from({ length: n }, () => ({ target_id: id, event_type: 'recommend_impression' }))

  it('无曝光事件 → 乘子中性，顺序只由特征分决定（P1 零数据中性）', () => {
    const rows = [makeCard({ id: 'fresh-a' }), makeCard({ id: 'fresh-b' })]
    const out = applyRescore(rows, baseContext())
    expect(out.every((r) => (r.score_breakdown as Record<string, number>).engagement === 1)).toBe(
      true
    )
  })

  it('被反复曝光却从未点击的卡，被从未展示过的卡翻到前面', () => {
    const seen = makeCard({ id: 'seen-10x' })
    const fresh = makeCard({ id: 'fresh' })
    // 同质 → 基线同分；差别只来自曝光历史
    const ctx = ctxWith(repeat(10, 'seen-10x'))
    const out = applyRescore([seen, fresh], ctx)
    expect(out[0].id).toBe('fresh')
    expect(out[1].id).toBe('seen-10x')
  })

  it('点过的卡不被疲劳惩罚（点了还降权是自相矛盾）', () => {
    // 疲劳层单独断言：点过之后 exposureFatigueFactor 必须是 1
    expect(exposureFatigueFactor(12, 1)).toBe(1)
    // 集成口径：点过的卡绝不会被降权（这里反而因簇级高互动率上浮到 1.2，是对的）
    const clicked = makeCard({ id: 'clicked' })
    const ctx = ctxWith([
      ...repeat(12, 'clicked'),
      { target_id: 'clicked', event_type: 'recommend_click' },
    ])
    const out = applyRescore([clicked], ctx)
    expect((out[0].score_breakdown as Record<string, number>).engagement).toBeGreaterThanOrEqual(1)
  })

  it('簇级学习能跨过卡片过期，推广到该方向的新卡', () => {
    // 这张老卡已经退场（不在待排列表里），但它攒下的曝光必须仍然算进 c_a 的账上。
    // 若簇归属字典只装"当批卡"，这里就会退化成 1 —— 簇级学习等于没做。
    const oldCard = 'old-card-in-c_a'
    const ctx = buildRescoreContext({
      clusters: [aCluster('c_a', UNIT_X), aCluster('c_off', UNIT_Y)],
      engagementRows: repeat(20, oldCard),
      cardClusters: new Map([[oldCard, 'c_a']]),
      now: new Date('2026-09-25T00:00:00.000Z'),
    })
    const neverShown = makeCard({ id: 'never-shown', cluster_code: 'c_a' })
    const offCluster = makeCard({ id: 'other-cluster', cluster_code: 'c_off' })
    const out = applyRescore([neverShown, offCluster], ctx)

    const hit = out.find((r) => r.id === 'never-shown')!
    const miss = out.find((r) => r.id === 'other-cluster')!
    expect((hit.score_breakdown as Record<string, number>).engagement).toBeLessThan(1)
    expect((miss.score_breakdown as Record<string, number>).engagement).toBe(1)
  })

  it('乘子写进 score_breakdown.engagement，可被观测（不埋暗桩）', () => {
    const card = makeCard({ id: 'c1' })
    const out = applyRescore([card], ctxWith(repeat(8, 'c1')))
    expect((out[0].score_breakdown as Record<string, number>).engagement).toBeLessThan(1)
  })

  it('不可重排的旧卡也吃互动乘子（不能靠缺特征豁免惩罚）', () => {
    const legacy = makeCard({
      id: 'legacy-seen',
      ranking_features: undefined,
      score: 0.42,
    })
    const out = applyRescore([legacy], ctxWith(repeat(12, 'legacy-seen')))
    expect(out[0].score).toBeLessThan(0.42)
  })

  it('乘子有界：极端曝光也不会把分打成 0 或负数', () => {
    const card = makeCard({ id: 'bombarded', score: 0.8 })
    const out = applyRescore([card], ctxWith(repeat(500, 'bombarded')))
    expect(out[0].score).toBeGreaterThan(0)
    expect(out[0].score).toBeLessThanOrEqual(0.8)
  })
})

describe('recentCentroid：与离线共用同一实现', () => {
  it('buildRescoreContext 复用 ranking.recentBehaviorCentroid', () => {
    const clusters = [aCluster('c_a', UNIT_X), aCluster('c_b', UNIT_Y)]
    const now = new Date('2026-09-25T00:00:00.000Z')
    const ctx = buildRescoreContext({ clusters, now })
    expect(ctx.recentCentroid).toEqual(recentBehaviorCentroid(clusters, now))
  })
})
