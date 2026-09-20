'use client'

import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'

type OtpInputProps = {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  length?: number
}

/**
 * 6 位验证码输入组件:每格 1 字符,自动跳格,粘贴整段,Backspace 回退
 */
export function OtpInput({ value, onChange, disabled, length = 6 }: OtpInputProps) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  // 把 value 补齐到 length 长度的字符数组
  const chars = Array.from({ length }, (_, i) => value[i] ?? '')

  const focusAt = (i: number) => {
    if (i >= 0 && i < length) {
      inputRefs.current[i]?.focus()
      inputRefs.current[i]?.select()
    }
  }

  const handleChange = (i: number, char: string) => {
    const next = chars.slice()
    next[i] = char.slice(-1) // 只取最后 1 位,防止 maxLength 不拦截
    onChange(next.join(''))
    if (char && i < length - 1) {
      focusAt(i + 1)
    }
  }

  const handleKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (!chars[i] && i > 0) {
        // 当前格为空,回退到上一格并清空
        e.preventDefault()
        const next = chars.slice()
        next[i - 1] = ''
        onChange(next.join(''))
        focusAt(i - 1)
      }
      // 当前格有内容,默认行为会清空当前格,onChange 由 input change 触发
    } else if (e.key === 'ArrowLeft' && i > 0) {
      e.preventDefault()
      focusAt(i - 1)
    } else if (e.key === 'ArrowRight' && i < length - 1) {
      e.preventDefault()
      focusAt(i + 1)
    }
  }

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').trim().slice(0, length)
    if (pasted) {
      onChange(pasted)
      // 焦点跳到已填充末尾或最后一格
      const focusIdx = pasted.length >= length ? length - 1 : pasted.length
      // 等下一帧 value 更新后再聚焦
      requestAnimationFrame(() => focusAt(focusIdx))
    }
  }

  return (
    <div className="flex gap-2 justify-center">
      {chars.map((char, i) => (
        <Input
          key={i}
          ref={(el) => {
            inputRefs.current[i] = el
          }}
          type="text"
          inputMode="numeric"
          pattern="\d*"
          maxLength={1}
          value={char}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          disabled={disabled}
          aria-label={`验证码第${i + 1}位`}
          className="w-12 h-14 text-center text-xl"
        />
      ))}
    </div>
  )
}
