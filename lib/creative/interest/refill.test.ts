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

const { getLastBuild, fetchActiveClusters, runBuild, getActiveSuggestions } = vi.hoisted(() => ({
  getLastBuild: vi.fn(),
  fetchActiveClusters: vi.fn(),
  runBuild: vi.fn(),
  getActiveSuggestions: vi.fn(),
}))

// 只 mock 到「提前返回」所需的依赖：no_build / no_cluster 都在触及
// 候选生成、打分、造卡之前就返回了，无需把整条依赖链拉进单测。
// getActiveSuggestions 是 topUpQueue 判断"队列里还有没有卡"的依据，必须可伪造。
vi.mock('./interestRepo', () => ({ getLastBuild, fetchActiveClusters }))
vi.mock('./builder', () => ({ runBuild }))
vi.mock('./suggestionRepo', () => ({
  getActiveSuggestions,
  insertSuggestions: vi.fn(),
}))

import { topUpQueue } from './refill'

const supabase = {} as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  runBuild.mockResolvedValue(undefined)
  getLastBuild.mockResolvedValue({ id: 'build-1' })
  fetchActiveClusters.mockResolvedValue([])
  // 默认队列为空 —— 沿用本文件原有三个用例的语义（不可行即回退重建）。
  // 「队列还有卡」的分支由下方新增的 describe 单独覆盖。
  getActiveSuggestions.mockResolvedValue([])
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

describe('topUpQueue：队列非空时不换血（保护正在翻的游标）', () => {
  it('refill 不可行但队列仍有卡 → 不重建，避免 cursor 失效后从头翻', async () => {
    // 核心回归。runBuild 末尾 supersedeExceptBuild 会把非本批次的 active 卡
    // 整批替换，用户手里的 cursor 指向的行随之消失 → getFeedPage 找不到
    // cursor 就从头翻，表现为"刷着刷着回到前面几张"。
    // 用户此刻还有一堆卡没看完，这次换血毫无收益，只有破坏。
    getActiveSuggestions.mockResolvedValue([{ id: 's1' }])
    await topUpQueue(supabase, 'user-has-cards')
    expect(runBuild).not.toHaveBeenCalled()
  })

  it('refill 不可行且队列已空 → 仍然重建（否则个性化永远不来）', async () => {
    // 队列空 = 没有正在消费的流可以打断。此时不 build，Feed 只会一直补
    // 全局热点，个性化永远不来，所以重建仍是唯一出路。
    getActiveSuggestions.mockResolvedValue([])
    await topUpQueue(supabase, 'user-empty-queue')
    expect(runBuild).toHaveBeenCalledTimes(1)
  })
})
