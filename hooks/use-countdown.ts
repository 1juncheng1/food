import { useState, useRef, useEffect, useCallback } from 'react'

/**
 * 倒计时 hook:用于注册页"获取验证码"按钮的 60 秒冷却
 * start(sec) 启动倒计时,到 0 自动停止;组件卸载时清理 interval
 */
export function useCountdown(_initialSec: number) {
  const [seconds, setSeconds] = useState(0)
  const [isCounting, setIsCounting] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clear = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const start = useCallback((sec: number) => {
    clear()
    setSeconds(sec)
    setIsCounting(true)
    intervalRef.current = setInterval(() => {
      setSeconds((prev) => {
        if (prev <= 1) {
          clear()
          setIsCounting(false)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }, [clear])

  useEffect(() => {
    return clear
  }, [clear])

  return { seconds, isCounting, start }
}
