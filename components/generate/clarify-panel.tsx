'use client'

// ============================================================
// 意图澄清卡（生成页澄清态）—— 意图澄清引擎阶段 2
//
// 当 /api/creative/plan 判定主题需要澄清时，前端进入 stage='clarify'，
// 本组件渲染 AI 生成的选择式问题（最多 3 个）。
//
// 交互原则：
//   1. 每个问题展示 2-4 个选项 + "自定义"切换；选中后高亮
//   2. 用户回答完所有问题才能"生成方案"（按钮禁用兜底）
//   3. "跳过澄清"兜底入口：直接用 AI 推断值生成，避免用户被卡
//   4. 顶部展示 AI 已识别的信息（inferred），给用户"AI 已理解"反馈
// ============================================================

import { useMemo, useState } from 'react'
import type {
  ClarificationDimension,
  ClarificationQuestion,
} from '@/lib/creative/intentClarity'
import type { ClarificationAnswer } from '@/lib/creative/intentClarity'

interface ClarifyPanelProps {
  /** 主题回显 */
  topic: string
  /** AI 判定要问的问题（1-3 个） */
  questions: ClarificationQuestion[]
  /** AI 已从主题推断出的信息（给用户反馈） */
  inferred: Partial<Record<ClarificationDimension, string>>
  /** AI 解释为什么要问 */
  reason: string
  /** 用户提交回答，进入阶段 B 生成 plan */
  onSubmit: (answers: ClarificationAnswer[]) => void
  /** 跳过澄清，用 AI 推断值直接生成 */
  onSkip: () => void
  /** 返回输入态改主题 */
  onBack: () => void
  /** 是否正在加载 plan（阶段 B 调用中） */
  loading?: boolean
}

const DIMENSION_LABEL: Record<ClarificationDimension, string> = {
  goal: '目标',
  audience: '受众',
  scenario: '场景',
  identity: '身份',
  criteria: '标准',
}

export function ClarifyPanel({
  topic,
  questions,
  inferred,
  reason,
  onSubmit,
  onSkip,
  onBack,
  loading = false,
}: ClarifyPanelProps) {
  // answers[dimension] = { value: 选中值或自定义文本, isCustom: 是否自定义 }
  const [answers, setAnswers] = useState<
    Record<string, { value: string; isCustom: boolean } | undefined>
  >({})
  // 每个问题的自定义输入文本（独立状态，避免切换时丢失已输入内容）
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({})

  // 所有问题是否都已回答
  const allAnswered = useMemo(
    () => questions.every((q) => {
      const a = answers[q.dimension]
      return a && a.value.trim().length > 0
    }),
    [answers, questions]
  )

  function selectOption(dim: string, option: string) {
    setAnswers((prev) => ({
      ...prev,
      [dim]: { value: option, isCustom: false },
    }))
  }

  function startCustom(dim: string) {
    setAnswers((prev) => ({
      ...prev,
      [dim]: { value: prev[dim]?.value ?? '', isCustom: true },
    }))
  }

  function setCustomValue(dim: string, val: string) {
    setCustomTexts((prev) => ({ ...prev, [dim]: val }))
    setAnswers((prev) => ({
      ...prev,
      [dim]: { value: val, isCustom: true },
    }))
  }

  function handleSubmit() {
    if (!allAnswered || loading) return
    const payload: ClarificationAnswer[] = questions.map((q) => ({
      dimension: q.dimension,
      answer: answers[q.dimension]?.value.trim() ?? '',
    })).filter((a) => a.answer.length > 0)
    if (payload.length > 0) onSubmit(payload)
  }

  // AI 已识别信息文本（顶部展示）
  const inferredEntries = useMemo(
    () => Object.entries(inferred).filter(([, v]) => typeof v === 'string' && v.trim()),
    [inferred]
  )

  return (
    <section className="mx-auto mt-6 max-w-3xl">
      {/* 头部：主题回显 + AI 已理解信息 */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
        <div className="flex items-center justify-between gap-4">
          <p className="text-[11px] font-medium text-zinc-500 tracking-wide uppercase">
            主题
          </p>
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 text-[11px] text-zinc-500 hover:text-indigo-300 transition"
          >
            返回改主题
          </button>
        </div>
        <p className="mt-2 text-base text-zinc-200">{topic}</p>

        {inferredEntries.length > 0 && (
          <div className="mt-4 border-t border-zinc-800 pt-4">
            <p className="text-[11px] font-medium text-zinc-500 tracking-wide uppercase mb-2">
              我已从主题中理解
            </p>
            <div className="flex flex-wrap gap-2">
              {inferredEntries.map(([dim, val]) => (
                <span
                  key={dim}
                  className="rounded-full border border-zinc-700 bg-zinc-800/60 px-3 py-1 text-xs text-zinc-300"
                >
                  {DIMENSION_LABEL[dim as ClarificationDimension] ?? dim}：{val}
                </span>
              ))}
            </div>
          </div>
        )}

        {reason && (
          <p className="mt-4 text-sm text-zinc-400 leading-relaxed">{reason}</p>
        )}
      </div>

      {/* 问题列表 */}
      <div className="mt-4 space-y-4">
        {questions.map((q, idx) => {
          const current = answers[q.dimension]
          return (
            <div
              key={q.dimension}
              className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5"
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600/20 text-xs font-medium text-indigo-300">
                  {idx + 1}
                </span>
                <div className="flex-1">
                  <p className="text-sm text-zinc-200">{q.question}</p>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 pl-9">
                {q.options.map((opt) => {
                  const selected = !current?.isCustom && current?.value === opt
                  return (
                    <button
                      key={opt}
                      type="button"
                      disabled={loading}
                      onClick={() => selectOption(q.dimension, opt)}
                      className={[
                        'rounded-xl border px-4 py-2.5 text-left text-sm transition',
                        selected
                          ? 'border-indigo-500 bg-indigo-600/20 text-indigo-200'
                          : 'border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100',
                        loading ? 'opacity-60 cursor-not-allowed' : '',
                      ].join(' ')}
                    >
                      {opt}
                    </button>
                  )
                })}

                {/* 自定义入口 */}
                {q.allowCustom && (
                  <div className="col-span-2">
                    {!current?.isCustom ? (
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => startCustom(q.dimension)}
                        className="text-xs text-zinc-500 hover:text-indigo-300 transition"
                      >
                        其他（自定义输入）
                      </button>
                    ) : (
                      <input
                        type="text"
                        value={customTexts[q.dimension] ?? current?.value ?? ''}
                        onChange={(e) => setCustomValue(q.dimension, e.target.value)}
                        disabled={loading}
                        placeholder="输入你的回答..."
                        className="w-full rounded-lg border border-indigo-500 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-400"
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 操作区 */}
      <div className="mt-6 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onSkip}
          disabled={loading}
          className="text-sm text-zinc-500 hover:text-zinc-300 transition disabled:opacity-50"
        >
          跳过澄清，用 AI 推断直接生成
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!allAnswered || loading}
          className={[
            'rounded-xl px-5 py-2.5 text-sm font-medium transition',
            allAnswered && !loading
              ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
              : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
          ].join(' ')}
        >
          {loading ? '生成方案中...' : '使用回答，生成方案'}
        </button>
      </div>
    </section>
  )
}
