// ============================================================
// Creator Interest Profile —— M2 计算引擎种子测试
//
// 核心验收场景（对应用户第六阶段测试案例）：
//   用户 A：10 个 AI 商业项目（5 个已定稿，跨越 30~57 天）
//          + 1 个电影项目的 3 次版本生成（2 天内，AI 判断 80% 在测试功能）
//   期望：AI 商业为 core 且权重归一为 1；电影为 temporary，
//        权重 < 0.1、置信度 ≤ 0.4；dismiss 后电影簇转负归档。
// ============================================================

import { describe, expect, it } from 'vitest'
import { clusterConfidence } from './confidence'
import {
  ageDays,
  adjudicateWithdrawals,
  reasonFactor,
  scoreClusters,
} from './scoring'
import { decideLayer, detectBurst, initialLayer } from './layering'
import { ewma, slope, trendDirection, windowScores } from './trends'
import type { EngineEvent, ReasonInterpretation } from './types'

const NOW = new Date('2026-09-18T12:00:00.000Z')

function isoDaysAgo(days: number, hour = 12): string {
  const d = new Date(NOW)
  d.setDate(d.getDate() - days)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

/** 1024 维：AI 语义基向量在 dim0，电影在 dim1，组内加确定性小噪声保证 cos>0.72 */
function vector(kind: 'ai' | 'movie', seed = 0): number[] {
  const v = new Array<number>(1024).fill(0)
  if (kind === 'ai') {
    v[0] = 1
    for (let i = 1; i <= 5; i++) v[i] = 0.05 + ((seed * 7 + i * 3) % 10) * 0.01
  } else {
    v[1] = 1
    for (let i = 2; i <= 4; i++) v[i] = 0.04 + ((seed * 5 + i) % 8) * 0.01
  }
  return v
}

let seq = 0
function ev(partial: Partial<EngineEvent> & Pick<EngineEvent, 'type' | 'targetType'>): EngineEvent {
  seq += 1
  return {
    id: `e${seq}`,
    targetId: `t${seq}`,
    projectId: null,
    occurredAt: NOW.toISOString(),
    embedding: null,
    interpretation: null,
    ...partial,
  }
}

const MOVIE_REASON: ReasonInterpretation = {
  reasons: [
    { code: 'testing_feature', probability: 0.8 },
    { code: 'narrative_research', probability: 0.1 },
    { code: 'genuine_interest', probability: 0.1 },
  ],
}

/** 构造第六阶段标准种子事件流（每次重置序号，保证两次构造结果可逐字段比较） */
function seedEvents(): EngineEvent[] {
  seq = 0
  const events: EngineEvent[] = []

  // 10 个 AI 商业项目，年龄 30~57 天；前 5 个已定稿
  for (let i = 0; i < 10; i++) {
    const projectId = `ai-p${i}`
    const age = 30 + i * 3
    events.push(
      ev({
        type: 'work_generate',
        targetType: 'generation',
        targetId: `ai-gen${i}`,
        projectId,
        occurredAt: isoDaysAgo(age),
        embedding: vector('ai', i),
      })
    )
    if (i < 5) {
      events.push(
        ev({
          type: 'work_finalize',
          targetType: 'project',
          targetId: projectId,
          projectId,
          occurredAt: isoDaysAgo(age, 13),
          embedding: vector('ai', i),
        })
      )
    }
  }

  // 1 个电影项目：3 个版本（V1/V2/V3），2 天内突发，80% 测试功能
  for (let v = 1; v <= 3; v++) {
    events.push(
      ev({
        type: 'work_generate',
        targetType: 'generation',
        targetId: `movie-gen-v${v}`,
        projectId: 'movie-p1',
        occurredAt: isoDaysAgo(v === 3 ? 1 : 2, 10 + v),
        embedding: vector('movie', v),
        interpretation: MOVIE_REASON,
      })
    )
  }

  return events
}

describe('原因折扣', () => {
  it('testing 0.8 + research 0.1 + genuine 0.1 = 0.25', () => {
    expect(reasonFactor(MOVIE_REASON)).toBeCloseTo(0.25, 5)
  })
  it('未解释事件按 1.0 处理（LLM 挂了不惩罚用户）', () => {
    expect(reasonFactor(null)).toBe(1)
    expect(reasonFactor({ reasons: [] })).toBe(1)
  })
})

describe('第六阶段种子场景：10 AI 商业 + 1 电影测试', () => {
  const clusters = scoreClusters(seedEvents(), NOW)
  const ai = clusters.find((c) => c.projectCount === 10)!
  const movie = clusters.find((c) => c.projectCount === 1)!

  it('聚成且仅聚成 2 个语义簇', () => {
    expect(clusters).toHaveLength(2)
    expect(ai).toBeTruthy()
    expect(movie).toBeTruthy()
  })

  it('AI 簇归一化权重为 1，电影簇权重 < 0.1（相差一个数量级）', () => {
    expect(ai.weight).toBeCloseTo(1, 5)
    expect(movie.weight).toBeLessThan(0.1)
  })

  it('电影 3 个版本仍是 1 个项目（版本刷票被项目封顶消灭）', () => {
    expect(movie.eventCount).toBe(3)
    expect(movie.projectCount).toBe(1)
  })

  it('电影簇 genuineRatio 低（测试概率高）', () => {
    // genuine 0.1 + research 0.1 = 0.2
    expect(movie.genuineRatio).toBeCloseTo(0.2, 5)
  })

  it('分层：AI=core，电影=temporary（观察期 + 突发）', () => {
    const movieTimes = movie.members.map((m) => m.occurredAt)
    expect(detectBurst(movieTimes)).toBe(true)
    expect(
      initialLayer({
        ageDays: ageDays(movie.firstSeenAt, NOW),
        projectCount: movie.projectCount,
        eventCount: movie.eventCount,
        weight: movie.weight,
        genuineRatio: movie.genuineRatio,
        burst: true,
      })
    ).toBe('temporary')

    const aiTimes = ai.members.map((m) => m.occurredAt)
    expect(detectBurst(aiTimes)).toBe(false)
    expect(
      decideLayer(
        {
          ageDays: ageDays(ai.firstSeenAt, NOW),
          projectCount: ai.projectCount,
          eventCount: ai.eventCount,
          weight: ai.weight,
          genuineRatio: ai.genuineRatio,
          burst: false,
        },
        null
      ).layer
    ).toBe('core')
  })

  it('置信度：AI>0.6；单项目电影硬上限 0.4', () => {
    const aiConf = clusterConfidence(
      { projectCount: ai.projectCount, members: ai.members, now: NOW },
      10,
      0
    )
    const movieConf = clusterConfidence(
      { projectCount: movie.projectCount, members: movie.members, now: NOW },
      3,
      3
    )
    expect(aiConf).toBeGreaterThan(0.6)
    expect(movieConf).toBeLessThanOrEqual(0.4)
  })

  it('对电影卡 dismiss 后电影簇转负（isNegative），AI 不受影响', () => {
    const withDismiss = [
      ...seedEvents(),
      ev({
        type: 'recommend_dismiss',
        targetType: 'inspiration',
        targetId: 'rec-movie-1',
        occurredAt: isoDaysAgo(0),
        embedding: vector('movie', 9),
      }),
    ]
    const next = scoreClusters(withDismiss, NOW)
    const movieAfter = next.find((c) => c.projectCount === 1)!
    expect(movieAfter.isNegative).toBe(true)
    expect(movieAfter.weight).toBe(0)
    expect(next.find((c) => c.projectCount === 10)!.weight).toBeCloseTo(1, 5)
  })

  it('确定性：相同输入两次 build 结果逐字段一致', () => {
    expect(JSON.stringify(scoreClusters(seedEvents(), NOW))).toBe(
      JSON.stringify(scoreClusters(seedEvents(), NOW))
    )
  })
})

describe('撤回裁决', () => {
  it('material_delete 撤回此前的 material_save（两者都不进评分）', () => {
    const survivors = adjudicateWithdrawals(
      [
        ev({ type: 'material_save', targetType: 'script', targetId: 's1', occurredAt: isoDaysAgo(3) }),
        ev({ type: 'material_delete', targetType: 'script', targetId: 's1', occurredAt: isoDaysAgo(1) }),
      ],
      NOW
    )
    expect(survivors).toHaveLength(0)
  })

  it('work_delete 撤回该作品此前的全部事件；删除事件本身保留（负分 -0.5）', () => {
    const survivors = adjudicateWithdrawals(
      [
        ev({ type: 'work_generate', targetType: 'generation', targetId: 'g1', projectId: 'p1', occurredAt: isoDaysAgo(5) }),
        ev({ type: 'feedback_like', targetType: 'generation', targetId: 'g1', projectId: 'p1', occurredAt: isoDaysAgo(4) }),
        ev({ type: 'work_delete', targetType: 'generation', targetId: 'g1', occurredAt: isoDaysAgo(2) }),
      ],
      NOW
    )
    expect(survivors).toHaveLength(1)
    expect(survivors[0].type).toBe('work_delete')
  })

  it('撤回定稿只剔除撤回时点之前的定稿；再次定稿保留', () => {
    const survivors = adjudicateWithdrawals(
      [
        ev({ type: 'work_finalize', targetType: 'project', targetId: 'p1', projectId: 'p1', occurredAt: isoDaysAgo(10) }),
        ev({ type: 'work_unfinalize', targetType: 'project', targetId: 'p1', projectId: 'p1', occurredAt: isoDaysAgo(5) }),
        ev({ type: 'work_finalize', targetType: 'project', targetId: 'p1', projectId: 'p1', occurredAt: isoDaysAgo(2) }),
      ],
      NOW
    )
    expect(survivors).toHaveLength(1)
    expect(survivors[0].occurredAt).toBe(isoDaysAgo(2))
  })
})

describe('分层迟滞', () => {
  const failing = {
    ageDays: 60,
    projectCount: 1,
    eventCount: 2,
    weight: 0.2,
    genuineRatio: 0.3,
    burst: false,
  }

  it('core 首次不达标：留任 core 并累计 1 次', () => {
    const d1 = decideLayer(failing, { layer: 'core', downgradeStreak: 0 })
    expect(d1.layer).toBe('core')
    expect(d1.downgradeStreak).toBe(1)
  })

  it('连续第 2 期不达标才降级到 exploration', () => {
    const d2 = decideLayer(failing, { layer: 'core', downgradeStreak: 1 })
    expect(d2.layer).toBe('exploration')
    expect(d2.changed).toBe(true)
  })

  it('升级即时生效，不设迟滞', () => {
    const strong = {
      ageDays: 40,
      projectCount: 4,
      eventCount: 9,
      weight: 0.9,
      genuineRatio: 0.9,
      burst: false,
    }
    expect(decideLayer(strong, { layer: 'temporary', downgradeStreak: 0 }).layer).toBe('core')
  })
})

describe('趋势', () => {
  it('窗口分按时间归窗', () => {
    const w = windowScores(
      [
        ev({ type: 'work_generate', targetType: 'generation', targetId: 'a', occurredAt: isoDaysAgo(3), embedding: vector('ai') }),
        ev({ type: 'work_generate', targetType: 'generation', targetId: 'b', occurredAt: isoDaysAgo(40), embedding: vector('ai') }),
      ],
      NOW
    )
    expect(w.d7).toBeGreaterThan(0)
    expect(w.d30).toBe(w.d7) // 40 天事件不进 d30
    expect(w.d90).toBeGreaterThan(w.d30)
  })

  it('方向：d7=0 为 dormant；显著上升为 rising；单期不判升降', () => {
    expect(trendDirection({ d7: 0, d30: 5, d90: 5, d365: 5 }, 10)).toBe('dormant')
    expect(trendDirection({ d7: 2, d30: 10, d90: 10, d365: 10 }, 5)).toBe('rising')
    expect(trendDirection({ d7: 2, d30: 10, d90: 10, d365: 10 }, null)).toBe('stable')
  })

  it('slope 归一化到 [-1,1]，EWMA 首期取当期值', () => {
    expect(slope(10, 5)).toBeCloseTo(0.5, 5)
    expect(ewma(null, 3)).toBe(3)
    expect(ewma(2, 4, 0.5)).toBe(3)
  })
})
