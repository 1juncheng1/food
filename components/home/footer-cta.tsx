'use client'

import Link from 'next/link'
import { useAuth } from '@/components/auth-provider'
import { Reveal, IconArrowRight } from '@/components/vision'

// ────────────────────────────────────────────────────────────
// 收尾：开始创作入口 + 页脚
//
// 不做发光面板、不做渐变块。一条细线把正文和收尾分开，
// 一句陈述 + 一个主行动，剩下的都让位给留白。
//
// 已登录用户 CTA 直接指向工作台；未登录用户在这里完成登录
// （功能页全部需登录，首页是唯一的登录入口）。
// ────────────────────────────────────────────────────────────

export function FooterCTA() {
  const { session, loading } = useAuth()
  const isLoggedIn = !!session

  return (
    <>
      <section id="start" className="pb-[clamp(56px,7vw,96px)]">
        <div className="vs-container">
          <Reveal className="border-t border-[var(--vs-line)] pt-[clamp(44px,6vw,76px)]">
            <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div>
                <h2 className="vs-h2">逃脱这通用人工智能的邋遢</h2>
                <p className="vs-body mt-4">
                  从一个模糊的想法开始，银河叙事陪你走到可以真正发布的那一刻。
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {loading ? (
                  <span className="vs-btn vs-btn-primary" aria-disabled>
                    开始创作
                  </span>
                ) : (
                  <Link
                    href={isLoggedIn ? '/dashboard' : '/login'}
                    className="vs-btn vs-btn-primary"
                  >
                    {isLoggedIn ? '进入工作台' : '登录后开始创作'}
                    <IconArrowRight size={16} />
                  </Link>
                )}
                <Link href="/explore" className="vs-btn vs-btn-ghost">
                  先看看别人在创作什么
                </Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="border-t border-[var(--vs-line)] py-9">
        <div className="vs-container flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <img
              src="/logo.png"
              alt="银河叙事 Logo"
              width={26}
              height={26}
              className="block shrink-0"
            />
            <img
              src="/logo-text.png"
              alt="银河叙事"
              className="vs-logo-text block shrink-0"
            />
          </div>
          <p className="vs-num vs-num-dim text-[12px]">
            © 2026 银河叙事 · 让 AI 学会你的表达
          </p>
        </div>
      </footer>
    </>
  )
}
