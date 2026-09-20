// ============================================================
// WF8：三平台 stub 适配器（抖音/B站/知乎）
//
// 阶段8预留：定义 ExternalTrendData 协议后，外部平台源在 registry
// 显式在册（缺席显式而非隐身），但 stub 永不触网、不产出数据。
// 红线：
//   1. stub.search 永不调用 fetch（测试用 throw 桩证明）
//   2. console.info 每平台仅一次（重复调用不刷屏）
//   3. stub 不算真实数据源：hasRealDataSources/ciSearch 的
//      noAdapters 估算模式回退语义不被破坏
// ============================================================

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { getEnabledAdapters, hasRealDataSources } from './registry'

const STUB_IDS = ['douyin', 'bilibili', 'zhihu'] as const
const isStubId = (id: string): boolean => (STUB_IDS as readonly string[]).includes(id)

beforeEach(() => {
  vi.stubEnv('TAVILY_API_KEY', '') // 测试聚焦 stub 路径（无真实源场景）
})

describe('WF8 stub 适配器注册', () => {
  it('无任何真实 key 时三平台 stub 也在册（能力显式缺席）', () => {
    const ids = getEnabledAdapters().map((a) => a.id)
    for (const p of STUB_IDS) expect(ids).toContain(p)
  })

  it('stub 标记 stub:true，真实 Tavily 适配器不带标记', () => {
    const adapters = getEnabledAdapters()
    expect(adapters.filter((a) => isStubId(a.id)).every((a) => a.stub === true)).toBe(true)
    expect(adapters.filter((a) => !isStubId(a.id)).every((a) => a.stub !== true)).toBe(true)
  })

  it('stub.search 永不触网：fetch 替换为 throw 仍返回空数组 + 原因', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('stub must never touch network')
    })
    const stubs = getEnabledAdapters().filter((a) => isStubId(a.id))
    expect(stubs).toHaveLength(3)
    for (const s of stubs) {
      const r = await s.search({ topic: 'AI创业' }, 5)
      expect(r.items).toEqual([])
      expect(typeof r.error).toBe('string')
    }
  })

  it('console.info 每平台仅一次（第二轮零新增）', async () => {
    vi.resetModules() // 重置模块内 announced 状态，隔离验证"首次"语义
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { getEnabledAdapters: fresh } = await import('./registry')
    const stubs = fresh().filter((a) => isStubId(a.id))
    await Promise.all(stubs.map((s) => s.search({ topic: 'x' }, 3)))
    expect(spy).toHaveBeenCalledTimes(3) // 每平台一次
    await Promise.all(stubs.map((s) => s.search({ topic: 'x' }, 3)))
    expect(spy).toHaveBeenCalledTimes(3) // 第二轮零新增
  })

  it('hasRealDataSources 不把 stub 算作真实数据源', () => {
    expect(hasRealDataSources()).toBe(false)
  })
})
