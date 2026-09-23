// ============================================================
// lib/creative/interest/refill —— 补货入口 topUpQueue 的回退决策
//
// 为什么单独建这个文件：
//   原先 feed/route.test.ts 断言「库存 ≤8 → runBuild 被调用」，那是穿透到 refill
//   内部实现的断言。route 的契约只有「触发 topUpQueue」——refill 什么时候决定
//   回退到 runBuild 是 refill 自己的职责，应当在这里覆盖。
//
// ⚠️ 关键陷阱（写新用例前务必读）：
//   refill 有两道进程级闸门 inflightUntil / lastAttemptAt，落在模块级 Map 上。
//   同一 userId 连续调用第二次会命中 REFILL_MIN_INTERVAL_MS（5 分钟）而返回
//   'locked' → 不再回退 runBuild。因此**每个用例必须用互不相同的 userId**，
//   否则会遇到「明明该重建却没重建」的假象，而且极难排查。
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const { getLastBuild, fetchActiveClusters, runBuild } = vi.hoisted(() => ({
  getLastBuild: vi.fn(),
  fetchActiveClusters: vi.fn(),
  runBuild: vi.fn(),
}))

// 只 mock 到「提前返回」所需的两个依赖：no_build / no_cluster 都在触及
// 候选生成、打分、造卡之前就返回了，无需把整条依赖链拉进单测。
vi.mock('./interestRepo', () => ({ getLastBuild, fetchActiveClusters }))
vi.mock('./builder', () => ({ runBuild }))

import { topUpQueue } from './refill'

const supabase = {} as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  runBuild.mockResolvedValue(undefined)
  getLastBuild.mockResolvedValue({ id: 'build-1' })
  fetchActiveClusters.mockResolvedValue([])
})

describe('topUpQueue：refill 不可行 → 回退 runBuild', () => {
  it('从未成功 build（no_build）→ 回退 runBuild(incremental)', async () => {
    getLastBuild.mockResolvedValue(null)
    await topUpQueue(supabase, 'user-no-build')
    expect(runBuild).toHaveBeenCalledTimes(1)
    expect(runBuild).toHaveBeenCalledWith(supabase, 'user-no-build', 'incremental')
  })

  it('无活跃簇（no_cluster）→ 回退 runBuild', async () => {
    await topUpQueue(supabase, 'user-no-cluster')
    expect(runBuild).toHaveBeenCalledTimes(1)
  })

  it('refill 内部抛异常 → 吞成 failed 并回退 runBuild，不向上抛', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    getLastBuild.mockRejectedValue(new Error('boom'))
    await expect(topUpQueue(supabase, 'user-failed')).resolves.toBeUndefined()
    expect(runBuild).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})

describe('topUpQueue：成本闸门', () => {
  it('同用户连续调用第二次 → 命中最小间隔 locked，不重复触发 runBuild', async () => {
    getLastBuild.mockResolvedValue(null)
    await topUpQueue(supabase, 'user-repeat')
    expect(runBuild).toHaveBeenCalledTimes(1)

    runBuild.mockClear()
    // 同一 userId 立刻再来一次：必须被 5 分钟最小间隔挡住，
    // 否则用户连续翻页会把一次 Reset「重建」放大成 N 次。
    await topUpQueue(supabase, 'user-repeat')
    expect(runBuild).not.toHaveBeenCalled()
  })
})
