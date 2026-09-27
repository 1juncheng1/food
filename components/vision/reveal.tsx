'use client'

import { useEffect, useRef, type ElementType, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// ────────────────────────────────────────────────────────────
// 滚动渐入：全站共用一个 IntersectionObserver，
// 避免每个元素各建一个 observer 造成的额外开销。
//
// 动效原则：慢、克制、只做 opacity 与 transform。
// 降级策略：
//   1. 不支持 IntersectionObserver → 直接显示
//   2. 用户偏好减少动效 → 直接显示
//   CSS 侧另有 @media (scripting: none) 兜底，JS 不可用时不隐藏内容。
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
    { threshold: 0.08, rootMargin: '0px 0px -12% 0px' },
  )
  return sharedObserver
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function Reveal({
  children,
  className,
  delay = 0,
  as,
}: {
  children: ReactNode
  className?: string
  /** 延迟毫秒数，用于同组元素交错出现 */
  delay?: number
  /** 渲染标签，默认 div */
  as?: ElementType
}) {
  const ref = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const show = () => {
      el.dataset.revealed = 'true'
    }

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
      className={cn('vs-reveal', className)}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  )
}
