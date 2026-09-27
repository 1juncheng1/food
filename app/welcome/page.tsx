'use client'

// ============================================================
// /welcome —— 注册后的沉浸式访谈页
//
// 刻意放在 (main) 路由组之外：那一层会套 SidebarLayout（左侧导航栏），
// 而 onboarding 应该是全屏、无干扰、没有旁路可走的。这里与 /login、/register
// 同级，只受根 layout 约束,因此不自带 AuthGuard——未登录由本页自己送 /login。
//
// 职责单一：判断这位用户是否还需要访谈。
//   - 未登录        → /login
//   - 仍需访谈      → 沉浸式访谈（首次/未完成/增量补问/版本过期四种情形）
//   - 已访谈完整    → /dashboard（老用户误入也不会被卡住）
//   - 状态查询失败  → /dashboard（不让接口故障挡住新用户进门）
//
// 刻意不复用 useInterviewTrigger：那个 hook 带 7 天免打扰冷却，
// 而"注册后 onboarding"是必经步骤，不该被冷却跳过。
// ============================================================

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getValidSession } from '@/lib/supabaseClient'
import { InterviewDialog } from '@/components/creative/interview-dialog'
import { shouldTriggerInterview } from '@/lib/creative/interviewTrigger'
import type { DeclarationDimension } from '@/lib/creative/creatorDeclaration'

export default function WelcomePage() {
  const router = useRouter()
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [showInterview, setShowInterview] = useState(false)
  const [missingDimensions, setMissingDimensions] = useState<
    DeclarationDimension[] | null
  >(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      const session = await getValidSession()
      if (cancelled) return
      if (!session) {
        router.replace('/login')
        return
      }
      setAccessToken(session.access_token)

      try {
        const res = await fetch('/api/creative/interview', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (!res.ok) throw new Error('访谈状态加载失败')
        const data = await res.json()
        if (cancelled) return

        const result = shouldTriggerInterview(data?.status?.declaration)
        if (!result.shouldTrigger) {
          // 已访谈完整：不做任何展示，直接进工作台
          router.replace('/dashboard')
          return
        }
        // 增量补问时只问缺的维度，老用户不必重答整套
        setMissingDimensions(result.missingDimensions ?? null)
        setShowInterview(true)
      } catch {
        // 查询失败按"已访谈"处理，避免把新用户挡在门外
        if (!cancelled) router.replace('/dashboard')
      } finally {
        if (!cancelled) setChecking(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [router])

  // 完成或跳过都进工作台（跳过由组件内部写 7 天免打扰标记）
  const enterDashboard = () => router.replace('/dashboard')

  return (
    <div className="inner-page" data-mode="creator">
      <div className="mx-auto w-full max-w-[760px] px-5 py-14">
        <div className="mb-9 text-center">
          <h1 className="text-[28px] font-semibold tracking-tight text-[var(--vs-ink)]">
            欢迎来到视界
          </h1>
          <p className="mt-3 text-[14px] leading-relaxed text-[var(--vs-ink-4)]">
            {checking
              ? '正在为你准备第一次对话…'
              : '回答几个问题，让 AI 从第一篇起就懂你的表达。'}
          </p>
        </div>

        {showInterview && accessToken && (
          <InterviewDialog
            immersive
            open={showInterview}
            accessToken={accessToken}
            dimensions={missingDimensions ?? undefined}
            onCompleted={enterDashboard}
            onDismiss={enterDashboard}
          />
        )}
      </div>
    </div>
  )
}
