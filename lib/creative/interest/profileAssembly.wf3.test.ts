// ============================================================
// WF3：Creative Profile 四字段扩展（schema_version 1→2）
//
// 用户要求拒绝"喜欢电影/喜欢科技"这类简单标签，要理解"为什么喜欢"：
//   topic_interest            —— top8 簇 {name, weight(0-100), reason}
//                               reason 模板必须引用真实行为计数（非 LLM）
//   creative_goals            —— 权威读 declaration.creator_goal，不 AI 推断
//   content_preference        —— likes=core 簇 label ∪ declaration 表达类维度
//                               dislikes=isNegative 簇 label ∪ avoid_preference
//   recent_creation_direction —— 近 7 天事件最多的最强簇（纯内存计算）
// 旧字段全保留（additive），旧消费者零破坏。
// ============================================================

import { describe, expect, it } from 'vitest'
import { assembleProfile, type ClusterView } from './profileAssembly'
import type { EngineEvent } from './types'

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

function cluster(over: Partial<ClusterView> = {}): ClusterView {
  return {
    clusterId: 'cl-1',
    code: 'c_ai',
    label: 'AI创业',
    summary: 'AI 相关创作',
    layer: 'core',
    weight: 0.8,
    confidence: 0.9,
    trend: 'rising',
    rawScore: 0.8,
    eventCount: 12,
    projectCount: 3,
    createCount: 4,
    finalizeCount: 2,
    saveCount: 0,
    firstSeenAt: isoDaysAgo(30),
    lastSeenAt: isoDaysAgo(1),
    genuineRatio: 0.9,
    isNegative: false,
    topEvidence: [],
    domains: { tech: 0.6 },
    keywords: ['AI', '创业'],
    ...over,
  }
}

function event(over: Partial<EngineEvent> = {}): EngineEvent {
  return {
    id: 'e-1',
    userId: 'u-1',
    type: 'work_generate',
    targetType: 'generation',
    targetId: null,
    projectId: null,
    category: null,
    contentDomain: null,
    embedding: null,
    topicExcerpt: null,
    payload: null,
    interpretStatus: 'none',
    interpretation: null,
    occurredAt: isoDaysAgo(1),
    clusterId: null,
    ...over,
  } as EngineEvent
}

const BASE_INPUT = {
  buildId: 'b-1',
  clusters: [cluster()],
  events: [event()],
  firstEventAt: isoDaysAgo(30),
  lastEventAt: isoDaysAgo(1),
}

describe('WF3：topic_interest（加权主题 + 理由）', () => {
  it('top8 簇按 weight 降序；weight 映射 0-100 量纲；reason 引用真实行为计数', () => {
    const p = assembleProfile({
      ...BASE_INPUT,
      clusters: [
        cluster({ weight: 0.9, eventCount: 12, createCount: 4 }),
        cluster({ clusterId: 'cl-2', code: 'c_movie', label: '悬疑电影', weight: 0.6, eventCount: 5, createCount: 1 }),
      ],
      events: Array.from({ length: 12 }, (_, i) => event({ id: `e-${i}`, clusterId: 'cl-1' })),
    })
    const ti = p.topic_interest as Array<{ name: string; weight: number; reason: string }>
    expect(ti).toHaveLength(2)
    expect(ti[0].name).toBe('AI创业')
    expect(ti[0].weight).toBe(90) // 0-100 量纲
    expect(ti[1].weight).toBe(60)
    // reason 是行为事实模板（含计数），不是 LLM 发挥
    expect(ti[0].reason).toContain('12')
  })

  it('负向簇不进 topic_interest', () => {
    const p = assembleProfile({
      ...BASE_INPUT,
      clusters: [cluster(), cluster({ clusterId: 'cl-x', label: '纯娱乐', isNegative: true, weight: 0.7 })],
    })
    const ti = p.topic_interest as Array<{ name: string }>
    expect(ti.map((t) => t.name)).not.toContain('纯娱乐')
  })
})

describe('WF3：creative_goals / content_preference（declaration 权威）', () => {
  it('creative_goals 读 declaration.creator_goal；无声明时空数组（不 AI 编造）', () => {
    const p1 = assembleProfile({
      ...BASE_INPUT,
      declaration: { creator_goal: '建立个人品牌' },
    } as never)
    expect(p1.creative_goals).toEqual(['建立个人品牌'])

    const p2 = assembleProfile(BASE_INPUT)
    expect(p2.creative_goals).toEqual([])
  })

  it('content_preference.likes 含 core 簇 label；dislikes 含负向簇 label 与 avoid_preference', () => {
    const p = assembleProfile({
      ...BASE_INPUT,
      clusters: [
        cluster({ label: 'AI创业' }),
        cluster({ clusterId: 'cl-x', code: 'c_ent', label: '纯娱乐', layer: 'temporary', isNegative: true }),
      ],
      declaration: { avoid_preference: '空洞鸡汤' },
    } as never)
    const cp = p.content_preference as { likes: string[]; dislikes: string[] }
    expect(cp.likes).toContain('AI创业')
    expect(cp.dislikes).toContain('纯娱乐')
    expect(cp.dislikes).toContain('空洞鸡汤')
  })
})

describe('WF3：recent_creation_direction（近 7 天最强簇）', () => {
  it('取近 7 天事件数最多的非负向簇；7 天前的事件不计入', () => {
    const p = assembleProfile({
      ...BASE_INPUT,
      clusters: [
        cluster({ clusterId: 'cl-1', code: 'c_ai', label: 'AI创业' }),
        cluster({ clusterId: 'cl-2', code: 'c_movie', label: '悬疑电影' }),
      ],
      events: [
        ...Array.from({ length: 3 }, (_, i) => event({ id: `a-${i}`, clusterId: 'cl-1', occurredAt: isoDaysAgo(2) })),
        ...Array.from({ length: 5 }, (_, i) => event({ id: `b-${i}`, clusterId: 'cl-2', occurredAt: isoDaysAgo(3) })),
        event({ id: 'old-1', clusterId: 'cl-1', occurredAt: isoDaysAgo(10) }), // 窗口外
      ],
    })
    const rcd = p.recent_creation_direction as { code: string; label: string; recentEvents: number }
    expect(rcd.code).toBe('c_movie')
    expect(rcd.recentEvents).toBe(5)
  })

  it('近 7 天无事件 → null（诚实降级）', () => {
    const p = assembleProfile({
      ...BASE_INPUT,
      events: [event({ occurredAt: isoDaysAgo(20) })],
    })
    expect(p.recent_creation_direction).toBeNull()
  })
})

describe('WF3：兼容性', () => {
  it('schema_version 升 2；旧字段 core/exploration/domains 全保留', () => {
    const p = assembleProfile(BASE_INPUT)
    expect(p.schema_version).toBe(2)
    expect(p.core).toBeDefined()
    expect(p.domains).toBeDefined()
    expect(p.behavior_reason_summary).toBeDefined()
  })
})
