// ============================================================
// lib/llm —— LLM 超时预算
//
// 这里锁住一条**资金规则**：LLM 预算必须显著小于所在路由的 maxDuration。
//
// 为什么值得单独写测试：AI 消费是「调用前预扣 → 调用后结算，失败全额退」，
// 退款代码跑在 LLM 调用失败之后。若平台先到达 maxDuration 把进程杀掉，
// 退款根本不会执行——用户没拿到结果，积分却被扣走。
// 这条规则一旦被改坏，表现为"用户被扣钱且没内容"，是最难被察觉的一类事故。
//
// 同时锁住反面：预算也不能**过小**。统一取 25s 会让 maxDuration=60 的
// 路由浪费 35s 可用时间，7000-token 的长方案被自己掐断，是功能回归。
// ============================================================

import { afterEach, describe, expect, it } from 'vitest'
import { llmBudgetMs, llmTimeoutMs } from './llm'

/** 测试会改环境变量，用完必须还原，否则污染同进程的其它测试 */
const ORIGINAL_BUDGET = process.env.AI_TIMEOUT_BUDGET_MS

afterEach(() => {
  if (ORIGINAL_BUDGET === undefined) delete process.env.AI_TIMEOUT_BUDGET_MS
  else process.env.AI_TIMEOUT_BUDGET_MS = ORIGINAL_BUDGET
})

describe('llmBudgetMs：预算 = 路由 maxDuration - 5s 余量', () => {
  it('★按路由算：60s 路由拿 55s，30s 路由拿 25s', () => {
    expect(llmBudgetMs(60)).toBe(55_000)
    expect(llmBudgetMs(30)).toBe(25_000)
    expect(llmBudgetMs(45)).toBe(40_000)
  })

  it('★未声明路由时兜底 25s（对齐站内最严格的 maxDuration=30）', () => {
    // 兜底值必须迁就**最严格**的路由：宁可让长任务早失败（会正确退款），
    // 也不能让某个 30s 路由拿到超过平台的预算（退款根本跑不到）。
    expect(llmBudgetMs()).toBe(25_000)
    expect(llmBudgetMs(undefined)).toBe(25_000)
  })

  it('★运维总闸只能收紧，不能放松', () => {
    process.env.AI_TIMEOUT_BUDGET_MS = '20000'
    // 路由想要 55s，但运维设了 20s → 取小
    expect(llmBudgetMs(60)).toBe(20_000)
    expect(llmBudgetMs()).toBe(20_000)
  })

  it('非法环境变量被忽略，不至于把预算压成 0 或 NaN', () => {
    process.env.AI_TIMEOUT_BUDGET_MS = '999' // 低于 5s 下限
    expect(llmBudgetMs(60)).toBe(55_000)
    process.env.AI_TIMEOUT_BUDGET_MS = 'abc'
    expect(llmBudgetMs(60)).toBe(55_000)
  })
})

describe('llmTimeoutMs：长输出不被兜底值掐断，短输出不浪费预算', () => {
  it('★7000 tokens 在 60s 路由上拿满 55s（不是兜底的 25s）', () => {
    // 15s + 7000/30*1000 ≈ 248s → 夹到路由预算
    expect(llmTimeoutMs(7000, 60)).toBe(55_000)
  })

  it('★同样的长输出在 30s 路由上只能拿 25s（绝不越过平台限制）', () => {
    expect(llmTimeoutMs(7000, 30)).toBe(25_000)
  })

  it('短输出用不满预算：按实际估算值走，并保住 20s 下限', () => {
    // 100 tokens → 15s + 3.3s ≈ 18.3s，低于下限 → 取 20s
    expect(llmTimeoutMs(100, 60)).toBe(20_000)
  })

  it('中等输出按估算值走，不受预算影响', () => {
    // 300 tokens → 15s + 10s = 25s
    expect(llmTimeoutMs(300, 60)).toBe(25_000)
  })
})
