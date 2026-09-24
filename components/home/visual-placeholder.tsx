'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { IconImage } from './home-icons'

// ────────────────────────────────────────────────────────────
// 视觉占位区：为未来的图片 / 视频预留位置。
//
// 约定路径（如 /images/home/inspiration.png）当前并不存在，
// 加载失败时自动降级为优雅占位区域，不出现裂图。
// 未来只要把图片放进 public 对应路径，无需改动任何代码。
// ────────────────────────────────────────────────────────────

interface VisualPlaceholderProps {
  /** 图片地址；为空时直接走占位 */
  src?: string
  alt?: string
  /** 占位区说明文字 */
  label?: string
  className?: string
  /** 是否显示网格底纹 */
  grid?: boolean
}

export function VisualPlaceholder({
  src,
  alt = '',
  label = '视觉区域',
  className,
  grid = true,
}: VisualPlaceholderProps) {
  const [failed, setFailed] = useState(false)
  const showFallback = !src || failed

  return (
    <div className={cn('vp', className)}>
      {grid && <div className="vp-canvas" aria-hidden="true" />}
      {!showFallback ? (
        <img
          src={src}
          alt={alt}
          className="vp-img"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="vp-fallback">
          <span className="vp-fallback-icon">
            <IconImage />
          </span>
          <span className="vp-fallback-label">{label}</span>
        </div>
      )}
    </div>
  )
}
