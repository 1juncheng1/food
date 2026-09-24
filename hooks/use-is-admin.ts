'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

// ────────────────────────────────────────────────────────────
// useIsAdmin —— 当前登录用户是否为管理员
//
// 语义与 useBalance 一致，三种状态必须分开：
//   true    → 是管理员（展示后台入口）
//   false   → 不是（**隐藏入口**，不显示"无权访问"去误导用户）
//   null    → 还没查到 / 未登录（同样隐藏，查不到不等于有权限）
//
// 这只是**前端可见性**。真正的权限校验在服务端 requireAdmin() +
// RPC 内的 is_service_caller()，前端隐藏从来不是安全边界。
// ────────────────────────────────────────────────────────────

export function useIsAdmin(enabled = true): boolean | null {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)

  useEffect(() => {
    if (!enabled) {
      setIsAdmin(null)
      return
    }
    let cancelled = false

    void (async () => {
      try {
        const { data, error } = await supabase.from('admin_users').select('user_id').maybeSingle()
        // RLS 只让人读自己那一行：查到行 = 是管理员；没行 = 不是
        if (!cancelled) setIsAdmin(!error && !!data)
      } catch {
        if (!cancelled) setIsAdmin(null)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [enabled])

  return isAdmin
}
