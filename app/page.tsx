'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useAuth } from '@/components/auth-provider'
import { supabase } from '@/lib/supabaseClient'

// ── 灵感示例数据 ──
const inspirations = [
  {
    icon: '🎬',
    title: '电影解说',
    desc: '深度影评人视角，拆解镜头语言与剧情隐喻',
    tag: '热门',
  },
  {
    icon: '🎭',
    title: '短剧解说',
    desc: '悬念开场，节奏紧凑，适合短视频平台传播',
    tag: '新品',
  },
  {
    icon: '📖',
    title: '读书解读',
    desc: '通俗大白话拆解好书，避开晦涩术语',
    tag: null,
  },
  {
    icon: '✨',
    title: '故事文案',
    desc: '氛围感叙事，金句开场，情绪层层递进',
    tag: null,
  },
  {
    icon: '🔥',
    title: '犀利吐槽',
    desc: '语言幽默，观点鲜明，自带网感与节奏',
    tag: '热门',
  },
  {
    icon: '🎞️',
    title: '纪录片解说',
    desc: '客观冷静，逻辑严谨，多角度利弊分析',
    tag: null,
  },
]

export default function HomePage() {
  const { session, loading } = useAuth()
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  const isLoggedIn = !!session
  const email = session?.user?.email ?? ''
  const displayName = email ? email.split('@')[0] : ''
  const initial = displayName ? displayName[0].toUpperCase() : 'U'

  /** 退出登录 */
  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    setMenuOpen(false)
    await supabase.auth.signOut()
    router.push('/')
    router.refresh()
  }

  return (
    <div className="home-page">
      {/* ── 流星层（纯装饰：5 颗错峰循环，位于星云之上、正文之下） ── */}
      <div className="meteor-layer" aria-hidden="true">
        <span className="meteor" style={{ '--m-top': '-6%', '--m-left': '18%', '--dur': '9s', '--delay': '-1s', '--dx': '-340px', '--dy': '500px', '--len': '120px' } as React.CSSProperties} />
        <span className="meteor" style={{ '--m-top': '-4%', '--m-left': '62%', '--dur': '11s', '--delay': '-5s', '--dx': '-300px', '--dy': '440px', '--len': '90px' } as React.CSSProperties} />
        <span className="meteor" style={{ '--m-top': '6%', '--m-left': '88%', '--dur': '10s', '--delay': '-8s', '--dx': '-280px', '--dy': '410px', '--len': '100px' } as React.CSSProperties} />
        <span className="meteor" style={{ '--m-top': '28%', '--m-left': '104%', '--dur': '12s', '--delay': '-3s', '--dx': '-380px', '--dy': '540px', '--len': '130px' } as React.CSSProperties} />
        <span className="meteor" style={{ '--m-top': '-2%', '--m-left': '40%', '--dur': '13s', '--delay': '-10s', '--dx': '-320px', '--dy': '470px', '--len': '110px' } as React.CSSProperties} />
      </div>

      {/* ── 导航栏 ── */}
      <header className="home-nav">
        <Link href="/" className="flex items-center gap-2.5">
          <img src="/logo.png" alt="视界 Logo" width={40} height={40} className="block shrink-0 logo-glow" />
          <span className="text-xl font-semibold text-white tracking-wide whitespace-nowrap leading-none">
            视界
          </span>
        </Link>

        {/* loading 时显示占位，避免闪烁 */}
        {loading ? (
          <div className="w-24 h-7 rounded-lg bg-white/5 animate-pulse" />
        ) : isLoggedIn ? (
          /* 已登录：显示头像 + 昵称 + 下拉菜单 */
          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition"
            >
              <span className="w-7 h-7 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-xs font-medium">
                {initial}
              </span>
              <span className="text-sm text-zinc-200 max-w-[120px] truncate">{displayName}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            {/* 下拉菜单 */}
            {menuOpen && (
              <>
                {/* 点击外部关闭 */}
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-2 w-48 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl py-1 z-50">
                  <Link
                    href="/dashboard"
                    className="block px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition"
                    onClick={() => setMenuOpen(false)}
                  >
                    进入工作台
                  </Link>
                  <Link
                    href="/profile/me"
                    className="block px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition"
                    onClick={() => setMenuOpen(false)}
                  >
                    我的主页
                  </Link>
                  <Link
                    href="/settings"
                    className="block px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition"
                    onClick={() => setMenuOpen(false)}
                  >
                    设置
                  </Link>
                  <div className="border-t border-zinc-800 my-1" />
                  <button
                    onClick={handleLogout}
                    disabled={loggingOut}
                    className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-zinc-800 transition disabled:opacity-40"
                  >
                    {loggingOut ? '退出中…' : '退出登录'}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          /* 未登录：显示登录按钮 */
          <Link
            href="/login"
            className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'rounded-lg')}
          >
            立即登录
          </Link>
        )}
      </header>

      {/* ── Hero 首屏 ── */}
      <section className="home-hero">
        {/* 片场氛围（纯 CSS 装饰：聚光灯光锥 + 暖色片场灯 + 台面反光 + 胶片暗角） */}
        <div className="stage-scene" aria-hidden="true">
          <div className="spot-cone" />
          <div className="spot-cone sc-2" />
          <div className="stage-lamp lamp-l" />
          <div className="stage-lamp lamp-r" />
          <div className="stage-floor" />
          <div className="film-vignette" />
        </div>
        <Badge variant="secondary" className="anim-rise mb-6 bg-white/5 text-white/60 border-white/10" style={{ animationDelay: '0.05s' }}>
          AI 驱动 · 越用越懂你
        </Badge>
        <h1 className="home-hero-title hero-gradient-text anim-rise" style={{ animationDelay: '0.15s' }}>
          打造你的专属<br />创作视界
        </h1>
        <p className="home-hero-subtitle anim-rise" style={{ animationDelay: '0.28s' }}>
          第一个理解创作者人格，并帮助创作者持续创造内容世界的AI平台。
        </p>
        <div className="home-hero-buttons anim-rise" style={{ animationDelay: '0.4s' }}>
          <Link href={isLoggedIn ? '/dashboard' : '/login'} className={cn(buttonVariants({ variant: 'default' }), 'home-btn-primary btn-shine')}>
            {isLoggedIn ? '进入视界' : '立即开始'}
          </Link>
        </div>
      </section>

      {/* ── 灵感示例 Card 网格 ── */}
      <section className="home-inspirations">
        <h2 className="home-section-title">灵感示例</h2>
        <p className="home-section-sub">没有灵感？但可以参考多种风格</p>
        <div className="home-grid stagger">
          {inspirations.map((item) => (
            <Card
              key={item.title}
              className="home-insp-card spotlight-card group"
              onMouseMove={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                const px = (e.clientX - r.left) / r.width
                const py = (e.clientY - r.top) / r.height
                e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
                e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
                e.currentTarget.style.setProperty('--rx', `${(px - 0.5) * 6}deg`)
                e.currentTarget.style.setProperty('--ry', `${(0.5 - py) * 6}deg`)
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.setProperty('--rx', '0deg')
                e.currentTarget.style.setProperty('--ry', '0deg')
              }}
            >
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="home-insp-icon">{item.icon}</div>
                  {item.tag && (
                    <Badge variant="secondary" className="bg-primary/15 text-primary border-primary/20">
                      {item.tag}
                    </Badge>
                  )}
                </div>
                <CardTitle className="home-insp-title">{item.title}</CardTitle>
                <CardDescription className="home-insp-desc">{item.desc}</CardDescription>
              </CardHeader>
              <CardContent>
                <Link
                  href={isLoggedIn ? '/dashboard' : '/login'}
                  className={cn(buttonVariants({ size: 'sm' }), 'w-full bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground border border-primary/20')}
                >
                  生成
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* ── 底部三步流程 ── */}
      <section className="home-steps">
        <div className="home-steps-row stagger">
          <div className="home-step">
            <div className="home-step-dot">1</div>
            <div className="home-step-text">选择方向</div>
          </div>
          <div className="home-step">
            <div className="home-step-dot">2</div>
            <div className="home-step-text">持续创作</div>
          </div>
          <div className="home-step">
            <div className="home-step-dot">3</div>
            <div className="home-step-text">最伟大的作品</div>
          </div>
        </div>
      </section>

      {/* ── 底部 ── */}
      <footer className="home-footer">
        © 2026 视界 · 让 AI 学会你的表达
      </footer>
    </div>
  )
}
