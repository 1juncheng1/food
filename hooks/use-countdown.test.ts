import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useCountdown } from './use-countdown'

describe('useCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('初始状态:未倒计时,seconds 为 0', () => {
    const { result } = renderHook(() => useCountdown(60))
    expect(result.current.seconds).toBe(0)
    expect(result.current.isCounting).toBe(false)
  })

  it('start(60) 后进入倒计时状态,seconds 为 60', () => {
    const { result } = renderHook(() => useCountdown(60))
    act(() => {
      result.current.start(60)
    })
    expect(result.current.seconds).toBe(60)
    expect(result.current.isCounting).toBe(true)
  })

  it('每秒递减 1', () => {
    const { result } = renderHook(() => useCountdown(60))
    act(() => {
      result.current.start(60)
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.seconds).toBe(59)
  })

  it('到 0 自动停止,isCounting 变 false', () => {
    const { result } = renderHook(() => useCountdown(60))
    act(() => {
      result.current.start(60)
    })
    act(() => {
      vi.advanceTimersByTime(60000)
    })
    expect(result.current.seconds).toBe(0)
    expect(result.current.isCounting).toBe(false)
  })

  it('组件卸载时清理 interval,不泄漏', () => {
    const { result, unmount } = renderHook(() => useCountdown(60))
    act(() => {
      result.current.start(60)
    })
    unmount()
    // 卸载后推进 timer 不应抛错(若 interval 未清理会有 warning/报错)
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(60000)
      })
    }).not.toThrow()
  })
})
