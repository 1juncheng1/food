'use client'

import { useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import {
  VISION_SLOT_MARK,
  VISION_SLOT_NOTE,
  type VisionSlotKind,
} from '@/lib/vision-assets'
import { IconSlot } from './icons'

// ────────────────────────────────────────────────────────────
// ImageSlot：全站唯一的图片位组件。
//
// 职责：
//   1. 统一图片来源（只能来自 /images/vision/ 注册表）
//   2. 真实素材不存在时，降级为"带标注的占位区"，不出现裂图
//   3. 占位区明确写出槽位类型，后续替换素材的人一眼看懂
//
// 不使用随机渐变、emoji、AI 图标代替最终视觉。
// ────────────────────────────────────────────────────────────

export function ImageSlot({
  src,
  alt = '',
  kind,
  mark,
  note,
  ratio,
  priority = false,
  scrim = false,
  grid = true,
  className,
  imgClassName,
  style,
  children,
}: {
  /** 图片地址，通常来自 visionImage() */
  src?: string
  alt?: string
  /** 槽位类型，决定占位态标识 */
  kind?: VisionSlotKind
  /** 覆盖占位标识文字 */
  mark?: string
  /** 覆盖占位说明文字 */
  note?: string
  /** 宽高比，如 '16 / 9'，用于预留空间防止布局跳动 */
  ratio?: string
  /** 首屏主视觉设为 true，提前加载避免 LCP 变慢 */
  priority?: boolean
  /** 是否压暗，叠加文字时开启 */
  scrim?: boolean
  /** 是否显示网格底纹 */
  grid?: boolean
  className?: string
  imgClassName?: string
  style?: CSSProperties
  /** 叠加在图片之上的内容（标题、说明等） */
  children?: React.ReactNode
}) {
  const [failed, setFailed] = useState(false)
  const showFallback = !src || failed

  return (
    <div
      className={cn('vs-slot', className)}
      style={{ aspectRatio: ratio, ...style }}
    >
      {grid && <div className="vs-grid" aria-hidden="true" />}

      {!showFallback ? (
        <img
          src={src}
          alt={alt}
          className={cn('vs-slot-img', imgClassName)}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          fetchPriority={priority ? 'high' : 'auto'}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="vs-slot-empty">
          <span className="vs-slot-empty-mark">
            <IconSlot size={20} />
          </span>
          {kind && (
            <span className="vs-slot-empty-kind">
              {mark ?? VISION_SLOT_MARK[kind]}
            </span>
          )}
          {kind && (
            <span className="vs-slot-empty-note">
              {note ?? VISION_SLOT_NOTE[kind]}
            </span>
          )}
        </div>
      )}

      {scrim && !showFallback && <div className="vs-scrim" aria-hidden="true" />}
      {children}
    </div>
  )
}
