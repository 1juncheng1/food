// ============================================================
// AI 请求级总预算（deadline）
//
// 解决的问题：重试循环**各自**拿一份完整超时预算，总和远超路由 maxDuration。
//
//   problemSolver 是 3 次重试 × llmTimeoutMs(7000, 60)=55s = 165s，
//   而 /api/problem-solve 的 maxDuration 只有 60s。
//   第 1 次慢（但成功返回了无效内容）→ 第 2 次发起后必然被平台硬杀。
//
// 为什么这是资金事故而不是普通超时：
//   预扣发生在 LLM 调用**之前**，退款发生在调用返回**之后**。
//   进程被平台杀掉时退款代码根本不会执行——用户没拿到结果，积分也没了。
//
// 解法：整条请求共享一个 deadline。每次 LLM 调用前先看剩余时间，
//   不够就**直接放弃、不发起请求**。
//
//   ★ 关键点：放弃发生在预扣之前，所以根本不会产生扣费。
//     "让它超时再退款"依赖退款代码能跑到（进程被杀就跑不到），
//     而"根本没扣"是不可能失效的——这是两种可靠性量级的差别。
//
// 为什么用 AsyncLocalStorage 而不是逐层传参：
//   重试循环散落在 10+ 个 lib 里（还有嵌套调用），逐层传 deadline 要改几十处
//   且必然漏。ALS 一次设置、整条调用链自动生效。
//   未设置 deadline 时 remainingAiBudgetMs() 返回 null，行为与改造前一致——
//   没接上的路由不会因此坏掉，只是继续享受不到保护。
// ============================================================

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 剩余时间低于这个值就不再发起新的 LLM 调用。
 *
 * 取 12s 而不是更小：一次调用要覆盖「TCP/TLS 握手 + 排队 + 首 token」，
 * 3000 tokens 的输出按 30 tok/s 也要 ~100s，真剩这么点时间重试毫无意义，
 * 只是给平台制造一个"杀进程"的机会。宁可直接降级。
 */
export const MIN_CALL_BUDGET_MS = 12_000

/** deadline 时间戳（epoch ms），按异步上下文隔离 */
const storage = new AsyncLocalStorage<number>()

/**
 * 显式配置的上限（运维可强制收紧）；null = 未配置
 */
function explicitBudgetMs(): number | null {
  const raw = Number(process.env.AI_TIMEOUT_BUDGET_MS)
  if (Number.isFinite(raw) && raw >= 5_000 && raw <= 300_000) return Math.floor(raw)
  return null
}

/**
 * 单次 LLM 调用的超时预算（毫秒）。
 *
 * ⚠ 这个数字必须**显著小于**所在路由的 maxDuration，否则会被平台硬杀。
 *
 * 为什么这是资金问题而不只是体验问题：
 *   AI 消费是「调用前预扣 → 调用后按真实用量结算，失败全额退」。
 *   退款发生在 LLM 调用失败后的代码路径里。若平台先到达 maxDuration
 *   把整个函数进程杀掉，退款代码根本没有机会执行——
 *   用户没拿到结果，积分却被扣走了。
 *   反过来，只要让 LLM **自己先超时**，就能走进正常的失败分支完成退款。
 *
 * 所以规则是：预算 = 路由 maxDuration - 5s 余量，
 * 余量留给鉴权、查库、写库和响应传输。
 *
 * ⚠ 预算必须**按路由**算，不能取全局单值：
 *   站内 maxDuration 从 20s 到 60s 都有。若统一取 25s（迁就最严的 30s 路由），
 *   /api/problem-solve 这类 maxDuration=60 的路由就白白浪费 35s 可用时间——
 *   7000-token 的长方案会在 25s 处被自己掐断，属于功能回归。
 *   反之若统一取 55s，30s 路由会被平台硬杀，又回到上面的账单事故。
 *   所以调用方要把自己路由的 maxDuration 传进来。
 *
 * 未传时兜底 25s，对应站内最严格的 maxDuration = 30（如 /api/creative/blueprint）。
 *
 * 环境变量 AI_TIMEOUT_BUDGET_MS 是**运维总闸**：配置了就对一切生效，
 * 取 min（只能收紧、不能放松），用于上游整体变慢时全局降载。
 */
export function llmBudgetMs(maxDurationSec?: number): number {
  const derived =
    typeof maxDurationSec === 'number' && maxDurationSec >= 10
      ? Math.max(20_000, maxDurationSec * 1000 - 5000)
      : 25_000
  const explicit = explicitBudgetMs()
  return explicit === null ? derived : Math.min(explicit, derived)
}

/**
 * 在当前异步上下文里设置 deadline 并执行 fn。
 *
 * @param maxDurationSec 必须与同文件 `export const maxDuration` 一致
 */
export function runWithAiDeadline<T>(maxDurationSec: number, fn: () => Promise<T>): Promise<T> {
  return storage.run(Date.now() + llmBudgetMs(maxDurationSec), fn)
}

/**
 * 当前请求剩余的 AI 预算（毫秒）。
 * 未设置 deadline（路由没接）时返回 null —— 表示"不限制"，行为同改造前。
 */
export function remainingAiBudgetMs(): number | null {
  const deadline = storage.getStore()
  if (deadline === undefined) return null
  return Math.max(0, deadline - Date.now())
}

/**
 * 路由 handler 包装器：
 *
 * ```ts
 * export const maxDuration = 60
 * export const POST = withAiDeadline(60, async (req) => { ... })
 * ```
 *
 * 两个 60 必须一致。写死而不是自动读取 maxDuration，是因为
 * route module 的 export 在运行时拿不到；写死至少让 reviewer 一眼能比对。
 */
export function withAiDeadline<A extends unknown[]>(
  maxDurationSec: number,
  handler: (...args: A) => Promise<Response>
): (...args: A) => Promise<Response> {
  return (...args: A) => runWithAiDeadline(maxDurationSec, () => handler(...args))
}
