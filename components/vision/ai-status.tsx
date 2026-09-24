'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  AI_FALLBACK_TEXT,
  AI_IDLE_HINT,
  AI_TASK_STEPS,
  type AiTaskKey,
} from '@/lib/ai-status'

/**
 * 全站唯一的「AI 正在工作」组件。
 *
 * AI 产品必须让用户知道 AI 在做什么，所以：
 * - 绝不出现「加载中…」这类无信息量的文案
 * - 文案描述 AI 正在理解用户的什么（创作方向 / 知识库 / 修改意图）
 * - 空闲时也要显示 AI 已就绪，而不是什么都不显示
 */

function AiDots({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[3px] text-indigo-300',
        className
      )}
      aria-hidden
    >
      <i className="vs-ai-dot" />
      <i className="vs-ai-dot" />
      <i className="vs-ai-dot" />
    </span>
  )
}

export function AiStatus({
  task,
  steps,
  active = false,
  step,
  hint,
  variant = 'inline',
  intervalMs = 2600,
  className,
}: {
  task?: AiTaskKey
  /** 自定义分步文案（不传则用 task 的预设） */
  steps?: readonly string[]
  active?: boolean
  /** 当前步索引；不传且 active 时自动按 intervalMs 推进 */
  step?: number
  hint?: string
  variant?: 'inline' | 'bar' | 'steps'
  intervalMs?: number
  className?: string
}) {
  const list = steps ?? (task ? AI_TASK_STEPS[task] : []) ?? []
  const idleHint = hint ?? (task ? AI_IDLE_HINT[task] : '') ?? ''
  const [autoStep, setAutoStep] = useState(0)

  useEffect(() => {
    if (!active || step !== undefined || list.length <= 1) return
    const timer = setInterval(
      () => setAutoStep((s) => (s + 1) % list.length),
      intervalMs
    )
    return () => clearInterval(timer)
  }, [active, step, list.length, intervalMs])

  const current = step !== undefined ? step : autoStep
  const text = active
    ? list.length
      ? list[Math.min(current, list.length - 1)]
      : AI_FALLBACK_TEXT
    : idleHint

  if (variant === 'inline') {
    return (
      <div
        className={cn(
          'flex items-center gap-2 text-[13px]',
          active ? 'text-indigo-200' : 'text-zinc-500',
          className
        )}
      >
        {active ? (
          <AiDots />
        ) : (
          <Sparkles size={13} className="text-zinc-500" />
        )}
        <span className="truncate">{text}</span>
      </div>
    )
  }

  if (variant === 'bar') {
    return (
      <div
        className={cn(
          'relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3',
          active && 'vs-ai-frame',
          className
        )}
      >
        <div className="flex items-center gap-2.5">
          {active ? (
            <AiDots />
          ) : (
            <Sparkles
              size={14}
              className={active ? 'text-indigo-300' : 'text-zinc-500'}
            />
          )}
          <span
            className={cn(
              'text-[13px] font-medium',
              active ? 'text-indigo-100' : 'text-zinc-500'
            )}
          >
            {text}
          </span>
        </div>
        {active && (
          <div className="vs-bar-track mt-2.5">
            <span className="vs-bar" />
          </div>
        )}
      </div>
    )
  }

  // variant === 'steps'
  return (
    <div
      className={cn(
        'relative rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3.5',
        active && 'vs-ai-frame',
        className
      )}
    >
      <ol className="space-y-2">
        {list.map((label, i) => {
          const done = i < current || (!active && list.length > 0)
          const isActive = active && i === current
          return (
            <li key={label} className="flex items-center gap-2.5">
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-medium',
                  done && 'bg-emerald-500/20 text-emerald-300',
                  isActive && 'bg-indigo-500/20 text-indigo-300',
                  !done && !isActive && 'bg-white/[0.06] text-zinc-600'
                )}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                className={cn(
                  'text-[13px]',
                  done && 'text-zinc-400',
                  isActive && 'text-indigo-100',
                  !done && !isActive && 'text-zinc-600'
                )}
              >
                {label}
                {isActive && <span className="animate-pulse"> …</span>}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** 紧凑版：用于按钮内 / 卡片角标，只显示一行 */
export function AiPulse({
  active = true,
  children,
  className,
}: {
  active?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 text-[12px]',
        active ? 'text-indigo-200' : 'text-zinc-500',
        className
      )}
    >
      {active ? <AiDots /> : <Sparkles size={12} />}
      {children}
    </span>
  )
}
