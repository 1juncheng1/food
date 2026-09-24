'use client'

import { useEffect, useRef, type ElementType, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// ────────────────────────────────────────────────────────────
// 滚动渐入：整个首页共用一个 IntersectionObserver，
// 避免每个卡片各建一个 observer 造成的额外开销。
//
// 降级策略：
//   1. 不支持 IntersectionObserver → 直接显示
//   2. 用户偏好减少动效 → 直接显示
// CSS 侧另有 @media (scripting: none) 兜底，JS 不可用时不隐藏内容。
// ────────────────────────────────────────────────────────────

type RevealCallback = () => void

let sharedObserver: IntersectionObserver | null = null
const callbacks = new WeakMap<Element, RevealCallback>()

function getSharedObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null
  if (sharedObserver) return sharedObserver
  sharedObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const el = entry.target
        const cb = callbacks.get(el)
        callbacks.delete(el)
        sharedObserver?.unobserve(el)
        cb?.()
      }
    },
    // 元素进入视口下缘以上约 12% 时触发，滚动感更自然
    { threshold: 0.08, rootMargin: '0px 0px -12% 0px' },
  )
  return sharedObserver
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface RevealProps {
  children: ReactNode
  className?: string
  /** 延迟毫秒数，用于同组元素交错 */
  delay?: number
  /** 渲染标签，默认 div */
  as?: ElementType
}

export function Reveal({ children, className, delay = 0, as }: RevealProps) {
  const ref = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const show = () => {
      el.dataset.revealed = 'true'
    }

    // 无 observer 或用户要求减少动效：立即显示，不做入场动画
    const observer = getSharedObserver()
    if (!observer || prefersReducedMotion()) {
      show()
      return
    }

    callbacks.set(el, show)
    observer.observe(el)
    return () => {
      observer.unobserve(el)
      callbacks.delete(el)
    }
  }, [])

  const Tag = (as ?? 'div') as ElementType

  return (
    <Tag
      ref={ref}
      className={cn('reveal', className)}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  )
}
