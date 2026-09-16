'use client'

import { useState } from 'react'
import { Sidebar } from '@/components/sidebar'
import { AuthGuard } from '@/components/auth-guard'

// ────────────────────────────────────────────────────────────
// (main) 路由组布局（客户端组件）：Sidebar 折叠/展开时联动内容区 margin
// ────────────────────────────────────────────────────────────

export function SidebarLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="flex min-h-screen bg-transparent">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      <main
        className={`flex-1 min-h-screen transition-all duration-300 ${collapsed ? 'ml-[60px]' : 'ml-[220px]'}`}
      >
        <AuthGuard>{children}</AuthGuard>
      </main>
    </div>
  )
}
