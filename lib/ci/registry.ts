// ============================================================
// CI Registry —— 适配器注册表 + 能力协商
//
// 按环境变量动态启用：有 TAVILY_API_KEY 才注册 Tavily 系 Adapter。
// 零配置的数据源自动缺席而非报错——与 getMarketProvider() 的降级哲学一致。
// 未来接入 B站/抖音/知乎（或数据服务商）时在此追加注册逻辑。
// ============================================================

import type { CISourceAdapter } from './types'
import { newsAdapter, webSearchAdapter } from './adapters/tavily'
import { douyinStubAdapter, bilibiliStubAdapter, zhihuStubAdapter } from './adapters/stubs'

/**
 * 当前可用的适配器列表（按调用时环境实时判定）。
 * WF8：三平台 stub 常驻在册（能力缺席显式化）；接入真实源时替换 stub。
 */
export function getEnabledAdapters(): CISourceAdapter[] {
  const adapters: CISourceAdapter[] = []
  if (process.env.TAVILY_API_KEY) {
    adapters.push(webSearchAdapter, newsAdapter)
  }
  // WF8 预留：抖音/知乎（数据服务商采购后）、B站（合规评估后）替换 stub
  adapters.push(douyinStubAdapter, bilibiliStubAdapter, zhihuStubAdapter)
  return adapters
}

/** 是否存在任何真实数据源（stub 不算——决定市场分析走 web 模式还是估算模式） */
export function hasRealDataSources(): boolean {
  return getEnabledAdapters().some((a) => !a.stub)
}
