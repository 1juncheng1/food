'use client'

import { useEffect, useRef } from 'react'
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
// 目标：它看起来就是页面里一段会动的画面，而不是一个播放器——
// 没有控件、没有播放按钮，用户不需要做任何操作。
// 做法：autoPlay + muted + 内联属性自动起播；微信额外在 JSBridge 就绪后补一次 play()。
// 封面：public/images/vision/home-opening-hero-image.png——
// 只在极少数环境彻底拒绝播放时兜底，避免露出黑框。
// ────────────────────────────────────────────────────────────

export function HeroSection() {
  const { session, loading } = useAuth()
  const isLoggedIn = !!session
  const videoRef = useRef<HTMLVideoElement>(null)

  // 微信（尤其安卓 X5 内核）会拦掉 <video autoPlay>，页面里就只剩一张不动的画面。
  // X5 唯一的放行时机是 JSBridge 就绪的那一刻，所以桥接完成后再补一次 play()。
  // 起播之后它就是一段无声循环画面，没有任何控件，看不出这是个视频。
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const tryPlay = () => {
      void video.play().catch(() => {})
    }

    tryPlay()

    type WeixinBridge = {
      invoke: (name: string, params: Record<string, never>, callback: () => void) => void
    }
    const win = window as unknown as { WeixinJSBridge?: WeixinBridge }

    if (win.WeixinJSBridge) {
      win.WeixinJSBridge.invoke('getNetworkType', {}, tryPlay)
    } else {
      document.addEventListener('WeixinJSBridgeReady', tryPlay, false)
    }

    return () => {
      document.removeEventListener('WeixinJSBridgeReady', tryPlay, false)
    }
  }, [])

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

          {/* 主视觉位：无声循环画面，自动起播，不给任何播放器控件 */}
          <div
            className="vs-rise lg:ml-auto lg:w-full lg:max-w-[440px]"
            style={{ animationDelay: '300ms' }}
          >
            <div className="vs-frame vs-frame-marked">
              <video
                ref={videoRef}
                className="vs-hero-video"
                src={HOME_HERO_VIDEO}
                poster={HOME_IMAGES.hero}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                aria-hidden="true"
                {...WECHAT_VIDEO_PROPS}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
