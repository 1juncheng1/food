// ============================================================
// WF8：三平台 stub 适配器（抖音/B站/知乎）
//
// 显式在册（能力缺席可见）但永不触网：
//   - search 恒返回空数组 + 未接入原因
//   - console.info 每平台仅一次（进程级幂等，不刷屏）
// 接入真实数据时：替换对应 stub 为真实 adapter，消费方零改动。
// ============================================================

import type { CISourceAdapter, CIPlatform, CIQuery } from '../types'

function makeStub(id: CIPlatform, reason: string): CISourceAdapter {
  let announced = false // 进程级：每平台只播报一次
  return {
    id,
    stub: true,
    capabilities: { metrics: [], publishedAt: false, comments: false },
    async search(_query: CIQuery, _limit: number) {
      if (!announced) {
        announced = true
        console.info(`[ci] ${id} 数据源未接入（${reason}），本次返回空集`)
      }
      return { items: [], error: reason }
    },
  }
}

export const douyinStubAdapter = makeStub('douyin', '待数据服务商接入')
export const bilibiliStubAdapter = makeStub('bilibili', '待合规评估后接入')
export const zhihuStubAdapter = makeStub('zhihu', '待数据服务商接入')
