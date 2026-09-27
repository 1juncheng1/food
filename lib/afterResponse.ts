// ============================================================
// afterResponse —— 响应后的后台任务调度（推荐链路专用）
//
// 为什么需要它：推荐重建（runBuild）耗时 20–150s，业务路由只能 fire-and-forget。
// 但 `void task()` 在 serverless 上等于"响应一发出，进程随时被冻结"——
// 后台 build 大概率跑不完就死，表现为"删除/新增作品后推荐永远不变"，
// 而代码里看不出任何错误（这类静默失败极难排查）。
//
// `after()`（next/server，v15.1 起稳定）把任务挂到请求生命周期之后，
// 由平台的 waitUntil 延长实例存活时间，是这个问题的正解。
//
// 兜底：`after()` 在没有请求作用域时会抛错（单测直接调 route handler 就是这种场景）。
// 此时退回旧的 fire-and-forget 行为——测试环境与改造前完全等价，不引入回归。
// ============================================================

import { after } from 'next/server'

/**
 * 在响应发出后执行 task。task 内部必须自己吞掉异常（本函数只做调度，不做兜底语义）。
 */
export function afterResponse(task: () => Promise<unknown>): void {
  try {
    after(task)
  } catch {
    // 无请求作用域（单测 / 非 Next 运行时）：退化为立即后台执行，行为与改造前一致
    void task().catch(() => {})
  }
}
