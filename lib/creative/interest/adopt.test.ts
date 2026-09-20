// ============================================================
// WF1：adoptRecommendation —— 推荐采纳回流（plan 生成成功时调用）
//
// 用户从推荐卡进入创作并成功生成方案 = 推荐被采纳：
//   markConsumed（卡片离队）+ recommend_adopt 事件（权重 1.5）+ 触发增量重建。
// 整个函数必须永不抛错——回流失败绝不能影响创作主流程的响应。
// ============================================================

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { adoptRecommendation } from './adopt'
import type { SupabaseClient } from '@supabase/supabase-js'

const { trackEvent, markConsumed, runBuild } = vi.hoisted(() => ({
  trackEvent: vi.fn().mockResolvedValue({ ok: true, idempotencyKey: 'k' }),
  markConsumed: vi.fn().mockResolvedValue(undefined),
  runBuild: vi.fn().mockResolvedValue(null),
}))

vi.mock('./eventTracker', () => ({ trackEvent }))
vi.mock('./suggestionRepo', () => ({ markConsumed }))
vi.mock('./builder', () => ({ runBuild }))

const sb = {} as SupabaseClient

beforeEach(() => {
  // mockResolvedValue 实现保留，仅清空调用记录，避免跨用例断言泄漏
  vi.clearAllMocks()
})

describe('adoptRecommendation（WF1 采纳回流）', () => {
  it('正常采纳：markConsumed + recommend_adopt 事件 + 增量重建全部触发', async () => {
    await adoptRecommendation(sb, 'user-1', 'rec1', 'AI创业')

    expect(markConsumed).toHaveBeenCalledWith(sb, 'rec1')
    expect(trackEvent).toHaveBeenCalledTimes(1)
    const input = trackEvent.mock.calls[0][2]
    expect(input.type).toBe('recommend_adopt')
    expect(input.targetType).toBe('inspiration')
    expect(input.targetId).toBe('rec1')
    expect(input.topicExcerpt).toBe('AI创业')
    expect(runBuild).toHaveBeenCalledWith(sb, 'user-1', 'incremental')
  })

  it('recId 为空时 no-op：不触发任何下游（普通生成路径无 rec_id）', async () => {
    await adoptRecommendation(sb, 'user-1', '', '任意主题')
    expect(markConsumed).not.toHaveBeenCalled()
    expect(trackEvent).not.toHaveBeenCalled()
    expect(runBuild).not.toHaveBeenCalled()
  })

  it('下游抛错也不向上抛（回流绝不阻塞 plan 主流程）', async () => {
    markConsumed.mockRejectedValueOnce(new Error('network down'))
    await expect(adoptRecommendation(sb, 'user-1', 'rec1', 't')).resolves.toBeUndefined()
    expect(trackEvent).not.toHaveBeenCalled() // markConsumed 先行失败，后续不再执行
  })
})
