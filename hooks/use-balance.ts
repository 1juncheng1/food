'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

// ────────────────────────────────────────────────────────────
// useBalance —— 读取当前登录用户的账户余额
//
// 语义（与 lib/balance.ts 的 fail-open 红线一致）：
//   number  → 查到了余额（0 就是真的没钱）
//   null    → 还没查到 / 读取失败 / 未登录，**不是 0**
//             调用方必须放行：不得把"查不到"渲染成"请充值"
//
// 数据源：GET /api/user/balance（服务端用 ensureBalance 开户并查余额）
// ────────────────────────────────────────────────────────────

export function useBalance(enabled = true): number | null {
  const [balance, setBalance] = useState<number | null>(null)

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
        if (!res.ok) return // 401/503：保持 null，由调用方决定展示策略
        const data = (await res.json()) as { balance?: unknown }
        // 只在**明确是数字**时写入，null/undefined 一律视为"没查到"
        if (!cancelled && typeof data?.balance === 'number') {
          setBalance(data.balance)
        }
      } catch {
        // 网络异常：保持 null，不打扰用户
      }
    })()

    return () => {
      cancelled = true
    }
  }, [enabled])

  // enabled=false 时不查也不展示：这里直接判定，避免在 effect 里同步 setState 触发级联渲染
  return enabled ? balance : null
}
