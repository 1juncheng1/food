// ============================================================
// lib/aiDeadline —— 请求级 AI 总预算
//
// 锁住两件事：
//   ① 未接入的路由行为不变（返回 null = 不限制）——接入是渐进的，
//      不能因为引入这个模块就让没改过的路由坏掉。
//   ② 上下文隔离：并发请求各算各的。这条错了会导致
//      "一个慢请求把同进程其它请求的预算全吃光"——表现为
//      「别人在用的时候我就一直失败」，且极难排查。
// ============================================================

import { describe, expect, it } from 'vitest'
import { remainingAiBudgetMs, runWithAiDeadline } from './aiDeadline'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('请求级 AI 总预算', () => {
  it('★未接入时返回 null（不限制，行为同改造前）', () => {
    expect(remainingAiBudgetMs()).toBeNull()
  })

  it('接入后能读到剩余预算，且随时间递减', async () => {
    await runWithAiDeadline(60, async () => {
      const first = remainingAiBudgetMs()
      expect(first).not.toBeNull()
      expect(first!).toBeGreaterThan(50_000)
      expect(first!).toBeLessThanOrEqual(55_000)

      await sleep(30)
      expect(remainingAiBudgetMs()!).toBeLessThan(first!)
    })
  })

  it('★并发请求各自独立，不会互相干扰', async () => {
    const [slow, fast] = await Promise.all([
      runWithAiDeadline(60, async () => {
        await sleep(20)
        return remainingAiBudgetMs()
      }),
      runWithAiDeadline(30, async () => remainingAiBudgetMs()),
    ])
    expect(slow!).toBeGreaterThan(50_000)
    expect(fast!).toBeLessThanOrEqual(25_000)
  })

  it('★剩余预算恒非负（不会算出负的超时时间）', async () => {
    // 负值会让 Math.min(budget, remaining) 得到负超时 → 调用立即失败且原因诡异
    await runWithAiDeadline(10, async () => {
      expect(remainingAiBudgetMs()!).toBeGreaterThanOrEqual(0)
    })
  })

  it('★嵌套调用共享同一份预算（重试循环拿不到第二份）', async () => {
    // 这正是要解决的问题：重试循环里每次都拿满预算会撑爆 maxDuration
    await runWithAiDeadline(60, async () => {
      const before = remainingAiBudgetMs()!
      await sleep(30)
      const after = remainingAiBudgetMs()!
      expect(after).toBeLessThan(before)
      // 差值是真实流逝的时间，而不是"又拿到一份完整预算"
      expect(before - after).toBeGreaterThanOrEqual(25)
    })
  })
})
