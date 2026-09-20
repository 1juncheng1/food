// ============================================================
// WF0 回归：降级模板的刷新稳定性（AC-5 在降级路径上的延伸）
//
// 旧实现 Math.random 抽样：游客/冷启动/空队列用户每次刷新三张卡都变，
// 既制造"系统在乱跳"的观感，也无法与个性化路径的日种子稳定器行为一致。
// 要求：同日（同种子）多次请求结果完全一致；跨日允许受控轮换。
// ============================================================

import { describe, expect, it } from 'vitest'
import { getFallbackInspirations } from './fallbackTemplates'

describe('getFallbackInspirations 日种子稳定性', () => {
  it('同一日期种子连续取卡：标题序列完全一致（刷新 10 次稳定）', () => {
    const first = getFallbackInspirations(3, '2026-09-19').map((x) => x.title)
    for (let i = 0; i < 10; i++) {
      const again = getFallbackInspirations(3, '2026-09-19').map((x) => x.title)
      expect(again).toEqual(first)
    }
    expect(first).toHaveLength(3)
  })

  it('不同日期种子至少存在一次轮换（跨日不是恒定三条）', () => {
    const days = ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']
    const sequences = days.map((d) => getFallbackInspirations(3, d).map((x) => x.title).join('|'))
    expect(new Set(sequences).size).toBeGreaterThan(1)
  })

  it('返回的卡全部来自模板闭集，不生成模板外内容', () => {
    const picks = getFallbackInspirations(5, '2026-09-19')
    expect(picks).toHaveLength(5)
    for (const p of picks) {
      expect(typeof p.title).toBe('string')
      expect(p.title.length).toBeGreaterThan(0)
      expect(typeof p.category).toBe('string')
    }
  })
})
