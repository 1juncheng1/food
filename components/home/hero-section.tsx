'use client'

import Link from 'next/link'
import { useAuth } from '@/components/auth-provider'
import { IconArrowRight, IconPlay } from '@/components/vision'
import { HOME_HERO_VIDEO, HOME_IMAGES } from '@/lib/vision-assets'

// 微信内置浏览器的私有属性（iOS WKWebView / 安卓 X5 内核）。
// 缺了这些，微信会强制接管视频跳全屏播放器，或直接不显示画面。
// 它们不是标准 HTML 属性，TS 的 JSX 类型里没有，所以收口成 Record 后整体展开。
const WECHAT_VIDEO_PROPS: Record<string, string> = {
  'webkit-playsinline': 'true', // iOS 微信：内联播放，不强制全屏
  'x5-playsinline': 'true', // 安卓 X5：内联播放
  'x5-video-player-type': 'h5', // 安卓 X5：用 H5 播放器，在页面内播放
  'x5-video-player-fullscreen': 'true', // 安卓 X5：允许全屏
}

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
// 封面：public/images/vision/home-opening-hero-image.png——
// 微信内置浏览器一律拦截自动播放，不播时视频区会是一片黑，必须有封面图兜底。
// 因此这里不做 autoPlay：显示封面 + 原生控件，由用户点击后才开始播放。
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

          {/* 主视觉位：封面图 + 原生控件，点击后才播放（微信不允许自动播放） */}
          <div
            className="vs-rise lg:ml-auto lg:w-full lg:max-w-[440px]"
            style={{ animationDelay: '300ms' }}
          >
            <div className="vs-frame vs-frame-marked">
              <video
                className="vs-hero-video"
                src={HOME_HERO_VIDEO}
                poster={HOME_IMAGES.hero}
                controls
                muted
                loop
                playsInline
                preload="metadata"
                {...WECHAT_VIDEO_PROPS}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
