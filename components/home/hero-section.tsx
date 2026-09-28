'use client'

import Link from 'next/link'
import { useAuth } from '@/components/auth-provider'
import { IconArrowRight, IconPlay } from '@/components/vision'
import { HOME_HERO_VIDEO } from '@/lib/vision-assets'

// ────────────────────────────────────────────────────────────
// 首屏：电影级开场
//
// 结构（严格 4 个文本元素，不多一个）：
//   眉标 → 主标题 → 一句引言 → 行动区
//
// 左侧是"人说的话"，右侧是"人本身"：被取景框圈住的一段创作现场。
// 这是全站唯一需要优先加载的视觉，其余图片全部懒加载。
//
// 素材：public/vision.mp4（720×900 = 4:5，与框体比例一致，不产生裁切）
// 这一位只放视频本身，不再放任何静态封面图：
// 用户第一眼看到的就是画面在动，不存在先显示静态图再被视频盖住的过渡。
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

            <h1
              className="vs-display mt-5 vs-rise"
              style={{ animationDelay: '180ms' }}
            >
              让 AI 越来越懂你的创作伙伴
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

          {/* 主视觉位：只有 vision.mp4，没有静态封面图 */}
          <div
            className="vs-rise lg:ml-auto lg:w-full lg:max-w-[440px]"
            style={{ animationDelay: '300ms' }}
          >
            <div className="vs-frame vs-frame-marked">
              <video
                className="vs-hero-video"
                src={HOME_HERO_VIDEO}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                aria-hidden="true"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
