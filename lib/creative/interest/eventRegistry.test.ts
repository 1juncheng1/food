import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { EVENT_REGISTRY } from './config'
import type { CreatorEventType } from './types'

// ============================================================
// 事件注册表完整性
//
// 为什么需要这层测试：creator_events.event_type 有两处定义——
//   1. 应用层枚举 types.ts / 注册表 config.ts
//   2. 数据库 CHECK 约束 supabase/setup.sql
// TypeScript 只能保证第 1 处自洽（EVENT_REGISTRY 是
// Record<CreatorEventType, ...>，漏一个 key 就编译不过），**管不到第 2 处**。
//
// 漂移的后果很隐蔽：漏改 setup.sql 时，插入会被数据库 CHECK 拒绝，
// 而 trackEvent 铁律是「永不抛异常、只 console.error」——
// 事件静默丢失，业务照常跑，问题要到画像长期不准时才会被发现。
//
// G2（2026-09-24）新增 work_publish 时就踩在这个点上，故补此测试兜底。
// ============================================================
describe('EVENT_REGISTRY 与 setup.sql 的枚举一致性', () => {
  const sql = readFileSync(path.join(process.cwd(), 'supabase/setup.sql'), 'utf8')

  /** 从 setup.sql 里抠出某个 `xxx in (...)` 约束的字面量集合 */
  function inValues(pattern: RegExp, label: string): Set<string> {
    const m = sql.match(pattern)
    expect(m, `setup.sql 里没找到 ${label} 约束`).toBeTruthy()
    return new Set((m![1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, '')))
  }

  const eventTypeValues = inValues(
    /creator_events_event_type_check[\s\S]*?event_type in \(([\s\S]*?)\)/,
    'event_type'
  )

  it('setup.sql 的 event_type CHECK 覆盖全部事件类型（防枚举漂移）', () => {
    for (const t of Object.keys(EVENT_REGISTRY) as CreatorEventType[]) {
      expect(eventTypeValues.has(t), `事件类型 ${t} 未加入 setup.sql 的 CHECK 约束`).toBe(true)
    }
  })

  it('setup.sql 的 target_type CHECK 覆盖 post（发布事件的 target）', () => {
    const targetValues = inValues(/target_type in \(([^)]*)\)/, 'target_type')
    expect(targetValues.has('post')).toBe(true)
    expect(targetValues.has('project')).toBe(true)
  })

  it('work_publish 权重高于 work_finalize（发布强于定稿的设计意图）', () => {
    // 定稿 = 「我认可这个作品」；发布 = 「我愿意让世界看到它」
    expect(EVENT_REGISTRY.work_publish.weight).toBeGreaterThan(
      EVENT_REGISTRY.work_finalize.weight
    )
  })

  it('所有事件都有显式权重与 effect，无 undefined 条目', () => {
    for (const [type, entry] of Object.entries(EVENT_REGISTRY)) {
      expect(typeof entry.weight, `${type} 缺 weight`).toBe('number')
      expect(entry.effect, `${type} 缺 effect`).toBeTruthy()
    }
  })
})
