// ============================================================
// P0 数据闭环：重建触发判定测试
//
// 覆盖的核心回归：作品级行为（1 篇作品的增删）必须能触发重算。
// 旧阈值"脏事件 ≥5"把这条路径堵死了——1 篇作品只产生 1~3 条事件，
// 用户创作完回来看到的永远是同一批卡。
// ============================================================

import { describe, expect, it } from 'vitest'
import { countRebuildSignals, decideRebuild, type RebuildInput } from './rebuildTrigger'
import { RULE_VERSION } from './config'

const NOW = Date.parse('2026-09-23T12:00:00.000Z')

function base(over: Partial<RebuildInput> = {}): RebuildInput {
  return {
    hasProfile: true,
    profileUpdatedAt: '2026-09-23T11:00:00.000Z', // 1 小时前，未过期
    profileRuleVersion: RULE_VERSION, // 与当前评分公式同版本时才继续走后面的判定
    dirtyCount: 0,
    highSignalCount: 0,
    totalEvents: 20,
    now: NOW,
    ...over,
  }
}

describe('decideRebuild', () => {
  it('无画像且事件不足首建阈值 → 不触发（避免给噪声行为建画像）', () => {
    const r = decideRebuild(base({ hasProfile: false, totalEvents: 3 }))
    expect(r).toEqual({ needed: false, reason: 'none', workSignal: false })
  })

  it('无画像且事件达阈值 → first_build', () => {
    const r = decideRebuild(base({ hasProfile: false, totalEvents: 5 }))
    expect(r.needed).toBe(true)
    expect(r.reason).toBe('first_build')
  })

  it('一篇新作品（1 条高信号）→ work_signal 触发，这是本模块存在的主要理由', () => {
    const r = decideRebuild(base({ highSignalCount: 1, dirtyCount: 1 }))
    expect(r).toEqual({ needed: true, reason: 'work_signal', workSignal: true })
  })

  it('删除一篇作品同样立即触发（work_delete 属高信号）', () => {
    const r = decideRebuild(base({ highSignalCount: 1 }))
    expect(r.reason).toBe('work_signal')
    expect(r.workSignal).toBe(true)
  })

  it('作品级信号优先于 stale：画像同时过期时也归因到更具体的原因', () => {
    const r = decideRebuild(
      base({
        highSignalCount: 2,
        profileUpdatedAt: '2026-09-20T00:00:00.000Z', // 3 天前
      })
    )
    expect(r.reason).toBe('work_signal')
  })

  it('画像过期（>24h）且无作品级信号 → stale', () => {
    const r = decideRebuild(base({ profileUpdatedAt: '2026-09-22T11:00:00.000Z' })) // 25 小时前
    expect(r.needed).toBe(true)
    expect(r.reason).toBe('stale')
  })

  // BUILD_MAX_AGE_HOURS 从 1 放宽到 24：这是"什么都不做也会重建 20-150s"的唯一通道。
  // 锁住下界，防止有人为了"让画像更新鲜"把它调回小时级，把性能问题又带回来。
  it('画像 23 小时前更新且无新行为 → 不触发（过期窗口已放宽到 24h）', () => {
    const r = decideRebuild(
      base({ profileUpdatedAt: '2026-09-22T13:00:00.000Z', dirtyCount: 0, highSignalCount: 0 })
    )
    expect(r).toEqual({ needed: false, reason: 'none', workSignal: false })
  })

  it('一般行为累积达阈值 → dirty', () => {
    const r = decideRebuild(base({ dirtyCount: 5, highSignalCount: 0 }))
    expect(r.needed).toBe(true)
    expect(r.reason).toBe('dirty')
    expect(r.workSignal).toBe(false)
  })

  it('无新行为且画像新鲜 → 不触发', () => {
    const r = decideRebuild(base({ dirtyCount: 0, highSignalCount: 0 }))
    expect(r.needed).toBe(false)
  })

  it('画像 updated_at 非法/缺失时不误判 stale，落到 dirty 判定', () => {
    const r = decideRebuild(base({ profileUpdatedAt: 'not-a-date', dirtyCount: 5 }))
    expect(r.reason).toBe('dirty')
  })

  // ── 规则版本过期：评分公式升级后必须整体重建，否则新卡老卡同队列混排 ──

  it('画像规则版本落后于当前 RULE_VERSION → rule_upgrade', () => {
    // 生产实锤：两个用户的 profile.rule_version 停在 interest-rules-v2，
    // 而代码已到 v4，此前没有任何一处比较二者，公式升级等于没上线。
    const r = decideRebuild(base({ profileRuleVersion: 'interest-rules-v2' }))
    expect(r).toEqual({ needed: true, reason: 'rule_upgrade', workSignal: false })
  })

  it('rule_upgrade 压过 work_signal：这时走 refill 只会让混排更深', () => {
    // refill 是**追加**新卡 → 新卡按新公式、旧卡按旧公式，同一 score 字段排序 = 两把尺子。
    // 必须完整重建（supersede 旧卡）才能统一口径。
    const r = decideRebuild(base({ profileRuleVersion: 'interest-rules-v2', highSignalCount: 2 }))
    expect(r.needed).toBe(true)
    expect(r.reason).toBe('rule_upgrade')
    expect(r.workSignal).toBe(false)
  })

  it('rule_upgrade 压过 dirty 与 stale', () => {
    const r = decideRebuild(
      base({
        profileRuleVersion: 'interest-rules-v2',
        dirtyCount: 9,
        profileUpdatedAt: '2026-09-01T00:00:00.000Z',
      })
    )
    expect(r.reason).toBe('rule_upgrade')
  })

  it('画像缺失 rule_version（早于版本化之前生成）→ 同样判为过期', () => {
    const r = decideRebuild(base({ profileRuleVersion: null }))
    expect(r.reason).toBe('rule_upgrade')
  })

  it('自终止：重建后画像被写上当前 RULE_VERSION → 不再触发', () => {
    const r = decideRebuild(base({ profileRuleVersion: RULE_VERSION, dirtyCount: 0 }))
    expect(r).toEqual({ needed: false, reason: 'none', workSignal: false })
  })
})

describe('countRebuildSignals', () => {
  const row = (event_type: string, payload: Record<string, unknown> = {}) => ({ event_type, payload })

  it('曝光不计入脏事件：刷 5 张卡不该触发一次 20-150s 重建', () => {
    // 核心回归。recommend_impression 的 effect 是 stats_only、weight=0
    // （只做 CTR 分母，明确"绝不进兴趣分"），此前却照 +1 进 dirtyCount。
    // 于是刷满 5 张卡就命中 BUILD_DIRTY_EVENT_COUNT → runBuild
    // （全窗口重算 + 3 次 LLM，20-150s）：用户"看"这个动作竟能驱动最贵的一次计算。
    const r = countRebuildSignals(Array.from({ length: 20 }, () => row('recommend_impression')))
    expect(r.dirtyCount).toBe(0)
    expect(r.highSignalCount).toBe(0)
  })

  it('真实反馈照旧计入：点击与 ✕ 是用户的表达，曝光不是', () => {
    const r = countRebuildSignals([
      row('recommend_impression'),
      row('recommend_click'),
      row('recommend_dismiss'),
      row('recommend_impression'),
    ])
    expect(r.dirtyCount).toBe(2) // 只有 click 与 dismiss
    expect(r.highSignalCount).toBe(0)
  })

  it('作品级高信号照旧识别，不受曝光过滤影响', () => {
    const r = countRebuildSignals([
      row('recommend_impression'),
      row('work_generate', { topic_excerpt: '咖啡店选址' }),
    ])
    expect(r.highSignalCount).toBe(1)
    expect(r.freshWorkTopics).toEqual(['咖啡店选址'])
  })

  it('未知事件类型保守计入（新增事件类型时不会静默失去触发能力）', () => {
    expect(countRebuildSignals([row('some_future_event_type')]).dirtyCount).toBe(1)
  })

  it('event_type 缺失的行被跳过', () => {
    expect(countRebuildSignals([{ payload: {} }, {}]).dirtyCount).toBe(0)
  })
})
