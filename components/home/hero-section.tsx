'use client'

import Link from 'next/link'
import { useAuth } from '@/components/auth-provider'
import { IconArrowRight, IconPlay } from '@/components/vision'
import { HOME_HERO_GIF } from '@/lib/vision-assets'

// ────────────────────────────────────────────────────────────
// 首屏：电影级开场
//
// 结构（严格 4 个文本元素，不多一个）：
//   眉标 → 主标题 → 一句引言 → 行动区
//
// 左侧是"人说的话"，右侧是"人本身"：被取景框圈住的一段创作现场。
// 这是全站唯一需要优先加载的视觉，其余图片全部懒加载。
//
// 素材：public/vision.gif（480×600 = 4:5，与框体比例一致，不产生裁切）
// 为什么用 GIF 而不是 video：
//   微信内置浏览器会拦截 <video autoPlay>，导致页面只显示静态封面。
//   GIF 对微信来说就是一张普通图片，会自动循环播放，没有控件，用户不需要点击。
// ────────────────────────────────────────────────────────────

export function HeroSection() {
  const { session, loading } = useAuth()
  const isLoggedIn = !!session

  return (
    <section id="hero">
      <div className="vs-container pt-[clamp(92px,12vh,144px)] pb-[clamp(56px,7vw,104px)]">
        <div className="grid items-center gap-x-14 gap-y-12 lg:grid-cols-[minmax(0,1.04fr)_minmax(0,0.96fr)]">
          <div>
            <p className="vs-mark vs-rise" style={{ animationDelay: '80ms' }}>
              AI 创作空间
            </p>

            {/* 品牌名必须出现在 H1 里：H1 是相关性最强的信号之一，
                之前只有 <title> 含「视界 Vision」，导致搜品牌名时排不上 */}
            <h1
              className="vs-display mt-5 vs-rise"
              style={{ animationDelay: '180ms' }}
            >
              视界 Vision · 让 AI 越来越懂你的创作伙伴
            </h1>

            <p
              className="vs-lead mt-6 vs-rise"
              style={{ animationDelay: '280ms' }}
            >
              视界记住你的灵感、知识与表达方式，陪你把模糊的想法走成可以发布的作品。
            </p>

            <div
              className="mt-10 flex flex-wrap items-center gap-3 vs-rise"
              style={{ animationDelay: '380ms' }}
            >
              {loading ? (
                <span className="vs-btn vs-btn-primary" aria-disabled>
                  开始创作
                </span>
              ) : (
                <Link
                  href={isLoggedIn ? '/generate' : '/login'}
                  className="vs-btn vs-btn-primary"
                >
                  {isLoggedIn ? '开始创作' : '登录后开始创作'}
                  <IconArrowRight size={16} />
                </Link>
              )}
              <Link href="#growth" className="vs-btn vs-btn-ghost">
                <IconPlay size={15} />
                探索视界
              </Link>
            </div>
          </div>

          {/* 主视觉位：GIF 动图，自动循环，无视频控件 */}
          <div
            className="vs-rise lg:ml-auto lg:w-full lg:max-w-[440px]"
            style={{ animationDelay: '300ms' }}
          >
            <div className="vs-frame vs-frame-marked">
              <img
                src={HOME_HERO_GIF}
                alt=""
                className="vs-hero-video"
                loading="eager"
                decoding="async"
                aria-hidden="true"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
