// ============================================================
// P0 数据闭环：重建触发判定测试
//
// 覆盖的核心回归：作品级行为（1 篇作品的增删）必须能触发重算。
// 旧阈值"脏事件 ≥5"把这条路径堵死了——1 篇作品只产生 1~3 条事件，
// 用户创作完回来看到的永远是同一批卡。
// ============================================================

import { describe, expect, it } from 'vitest'
import { decideRebuild, type RebuildInput } from './rebuildTrigger'

const NOW = Date.parse('2026-09-23T12:00:00.000Z')

function base(over: Partial<RebuildInput> = {}): RebuildInput {
  return {
    hasProfile: true,
    profileUpdatedAt: '2026-09-23T11:00:00.000Z', // 1 小时前，未过期
    dirtyCount: 0,
    highSignalCount: 0,
    totalEvents: 20,
    now: NOW,
    ...over,
  }
}

describe('decideRebuild', () => {
  it('无画像且事件不足首建阈值 → 不触发（避免给噪声行为建画像）', () => {
    const r = decideRebuild(base({ hasProfile: false, totalEvents: 3 }))
    expect(r).toEqual({ needed: false, reason: 'none', workSignal: false })
  })

  it('无画像且事件达阈值 → first_build', () => {
    const r = decideRebuild(base({ hasProfile: false, totalEvents: 5 }))
    expect(r.needed).toBe(true)
    expect(r.reason).toBe('first_build')
  })

  it('一篇新作品（1 条高信号）→ work_signal 触发，这是本模块存在的主要理由', () => {
    const r = decideRebuild(base({ highSignalCount: 1, dirtyCount: 1 }))
    expect(r).toEqual({ needed: true, reason: 'work_signal', workSignal: true })
  })

  it('删除一篇作品同样立即触发（work_delete 属高信号）', () => {
    const r = decideRebuild(base({ highSignalCount: 1 }))
    expect(r.reason).toBe('work_signal')
    expect(r.workSignal).toBe(true)
  })

  it('作品级信号优先于 stale：画像同时过期时也归因到更具体的原因', () => {
    const r = decideRebuild(
      base({
        highSignalCount: 2,
        profileUpdatedAt: '2026-09-20T00:00:00.000Z', // 3 天前
      })
    )
    expect(r.reason).toBe('work_signal')
  })

  it('画像过期（>1h）且无作品级信号 → stale', () => {
    const r = decideRebuild(base({ profileUpdatedAt: '2026-09-23T09:00:00.000Z' }))
    expect(r.needed).toBe(true)
    expect(r.reason).toBe('stale')
  })

  it('一般行为累积达阈值 → dirty', () => {
    const r = decideRebuild(base({ dirtyCount: 5, highSignalCount: 0 }))
    expect(r.needed).toBe(true)
    expect(r.reason).toBe('dirty')
    expect(r.workSignal).toBe(false)
  })

  it('无新行为且画像新鲜 → 不触发', () => {
    const r = decideRebuild(base({ dirtyCount: 0, highSignalCount: 0 }))
    expect(r.needed).toBe(false)
  })

  it('画像 updated_at 非法/缺失时不误判 stale，落到 dirty 判定', () => {
    const r = decideRebuild(base({ profileUpdatedAt: 'not-a-date', dirtyCount: 5 }))
    expect(r.reason).toBe('dirty')
  })
})
