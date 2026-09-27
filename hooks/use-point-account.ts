'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

// ────────────────────────────────────────────────────────────
// usePointAccount —— 余额 + 价格口径（Phase 5 新增）
//
// 与旧的 useBalance 的差别：多带回 `pointsPerYuan`。
//
// 为什么要把它一起带回来：页面上但凡出现「X 积分 ≈ ¥Y」这类换算，
// 就必须用服务端下发的汇率。此前 generate 页把「20 积分 ≈ ¥0.5」
// 写死在 JSX 里，管理员在后台把汇率调成 15 之后，页面会继续按 20 展示——
// 用户看到的和真实扣费不一致，这是最容易被投诉的一类 bug。
//
// 语义（沿用 fail-open 红线）：
//   balance === null        → 没查到（不是 0），调用方不得渲染成"请充值"
//   pointsPerYuan === null  → 没拿到汇率，调用方只展示积分、不要编价格
// ────────────────────────────────────────────────────────────

export interface PointAccount {
  /** 余额；null = 未登录 / 读取失败 / 还没查到 */
  balance: number | null
  /** 1 元 = ? 积分；null = 未拿到（此时不要做金额换算展示） */
  pointsPerYuan: number | null
  /** 单次 AI 消费的保底积分；null = 未拿到 */
  minGenerationCost: number | null
}

/** 空账户：未启用 / 未登录时的统一返回，避免各调用方各自拼 null */
const EMPTY_ACCOUNT: PointAccount = {
  balance: null,
  pointsPerYuan: null,
  minGenerationCost: null,
}

export function usePointAccount(enabled = true): PointAccount {
  const [account, setAccount] = useState<PointAccount>(EMPTY_ACCOUNT)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    void (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session || cancelled) return

      try {
        const res = await fetch('/api/user/balance', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        // 401/503：保持全 null，由调用方决定展示策略（不拦截、不误报欠费）
        if (!res.ok) return
        const data = (await res.json()) as {
          balance?: unknown
          pointsPerYuan?: unknown
          minGenerationCost?: unknown
        }
        if (cancelled) return
        setAccount({
          balance: typeof data.balance === 'number' ? data.balance : null,
          pointsPerYuan:
            typeof data.pointsPerYuan === 'number' && data.pointsPerYuan > 0
              ? data.pointsPerYuan
              : null,
          minGenerationCost:
            typeof data.minGenerationCost === 'number' ? data.minGenerationCost : null,
        })
      } catch {
        // 网络异常：保持 null，不打扰用户
      }
    })()

    return () => {
      cancelled = true
    }
  }, [enabled])

  // enabled=false 时不查也不展示：这里直接判定，避免在 effect 里同步 setState 触发级联渲染
  return enabled ? account : EMPTY_ACCOUNT
}
