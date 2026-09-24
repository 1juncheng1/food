'use client'

import Link from 'next/link'
import { useAuth } from '@/components/auth-provider'
import { Reveal } from './reveal'
import { IconArrowRight } from './home-icons'

// ────────────────────────────────────────────────────────────
// 开始创作入口 + 页脚
// 已登录用户 CTA 直接指向工作台；未登录用户**在这里就完成登录**——
// 功能页全部需登录，首页是唯一的登录入口，不能把人先放进内页再拦下来。
// ────────────────────────────────────────────────────────────

export function FooterCTA() {
  const { session, loading } = useAuth()
  const isLoggedIn = !!session

  return (
    <>
      <section className="lp-cta" id="start">
        <Reveal className="lp-cta-panel">
          <span className="lp-cta-glow" aria-hidden="true" />
          <h2 className="lp-cta-title lp-gradient-text">让AI越来越懂你的创作伙伴</h2>
          <p className="lp-cta-sub">
            从一个模糊的想法开始，视界陪你走到可以真正发布的那一刻。
          </p>
          <div className="lp-cta-actions">
            {loading ? (
              <span className="lp-btn lp-btn-primary lp-btn-loading">开始创作</span>
            ) : (
              <Link
                href={isLoggedIn ? '/dashboard' : '/login'}
                className="lp-btn lp-btn-primary btn-shine"
              >
                {isLoggedIn ? '进入工作台' : '登录后开始创作'}
                <IconArrowRight size={16} />
              </Link>
            )}
            <Link href="/explore" className="lp-btn lp-btn-ghost">
              先看看别人在创作什么
            </Link>
          </div>
        </Reveal>
      </section>

      <footer className="lp-footer">
        <div className="lp-container">
          <div className="lp-footer-brand">
            <img src="/logo.png" alt="视界 Logo" width={26} height={26} className="block logo-glow" />
            <img src="/logo-text.png" alt="视界 Vision" className="block logo-text logo-text-sm" />
          </div>
          <p className="lp-footer-copy">© 2026 视界 · 让 AI 学会你的表达</p>
        </div>
      </footer>
    </>
  )
}
