'use client'

import Link from 'next/link'
import { useAuth } from '@/components/auth-provider'
import { VisualPlaceholder } from './visual-placeholder'
import { IconArrowRight, IconPlay } from './home-icons'

// ────────────────────────────────────────────────────────────
// Hero 首屏
// 主标题：让AI越来越懂你的创作伙伴
// 补充句：从一个想法开始，创造属于你的作品
// 视觉区：预留图片 / 视频插槽，当前为占位区域
//
// 主 CTA 随登录态切换：未登录指向 /login（功能页全部需登录，
// 首页是唯一入口），已登录直接进创作页。
// ────────────────────────────────────────────────────────────

export function HeroSection() {
  const { session, loading } = useAuth()
  const isLoggedIn = !!session

  return (
    <section className="lp-hero" id="hero">
      {/* 品牌流星：保留 3 颗，轻量 CSS，不做粒子 */}
      <div className="meteor-layer" aria-hidden="true">
        <span className="meteor" style={{ '--m-top': '-6%', '--m-left': '22%', '--dur': '11s', '--delay': '-2s', '--dx': '-320px', '--dy': '460px', '--len': '110px' } as React.CSSProperties} />
        <span className="meteor" style={{ '--m-top': '-4%', '--m-left': '64%', '--dur': '13s', '--delay': '-7s', '--dx': '-300px', '--dy': '430px', '--len': '90px' } as React.CSSProperties} />
        <span className="meteor" style={{ '--m-top': '2%', '--m-left': '92%', '--dur': '12s', '--delay': '-11s', '--dx': '-280px', '--dy': '410px', '--len': '100px' } as React.CSSProperties} />
      </div>

      <div className="lp-container">
        <span className="lp-eyebrow anim-rise" style={{ animationDelay: '0.05s' }}>
          <span className="lp-eyebrow-dot" />
          AI 创作伙伴 · 越用越懂你
        </span>

        <h1 className="lp-hero-title lp-gradient-text anim-rise" style={{ animationDelay: '0.14s' }}>
          让AI越来越懂你的创作伙伴
        </h1>

        {/* 补充句：位于视觉区上方，说明"从想法到作品"的路径 */}
        <p className="lp-hero-lead anim-rise" style={{ animationDelay: '0.24s' }}>
          从一个想法开始，创造属于你的作品
        </p>

        <p className="lp-hero-sub anim-rise" style={{ animationDelay: '0.32s' }}>
          视界理解你的灵感、知识和表达方式，陪伴你完成每一次创作。
        </p>

        <div className="lp-hero-actions anim-rise" style={{ animationDelay: '0.4s' }}>
          {loading ? (
            <span className="lp-btn lp-btn-primary lp-btn-loading">开始创作</span>
          ) : (
            <Link
              href={isLoggedIn ? '/generate' : '/login'}
              className="lp-btn lp-btn-primary btn-shine"
            >
              {isLoggedIn ? '开始创作' : '登录后开始创作'}
              <IconArrowRight size={16} />
            </Link>
          )}
          <Link href="#growth" className="lp-btn lp-btn-ghost">
            <IconPlay size={15} />
            探索视界
          </Link>
        </div>
      </div>

      {/* Hero 视觉展示区：public/Hero.png，未来可替换为视频或动态视觉 */}
      <div className="lp-container lp-hero-visual anim-rise" style={{ animationDelay: '0.52s' }}>
        <div className="lp-hero-frame">
          <VisualPlaceholder
            src="/Hero.png"
            alt="创作者在书桌前整理素材与观点，灵感逐渐成形"
          />
        </div>
      </div>
    </section>
  )
}
