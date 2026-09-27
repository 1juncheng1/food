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
      <div>
        <div className="flex items-start justify-between gap-4">
          <p className="vs-mark">主题</p>
          <button type="button" onClick={onBack} className="vs-link shrink-0">
            返回改主题
          </button>
        </div>
        <p className="mt-2 text-[17px] leading-snug">{topic}</p>

        {inferredEntries.length > 0 && (
          <div className="vs-sec mt-4">
            <p className="vs-mark">我已从主题中理解</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {inferredEntries.map(([dim, val]) => (
                <span key={dim} className="vs-verdict">
                  {DIMENSION_LABEL[dim as ClarificationDimension] ?? dim}：{val}
                </span>
              ))}
            </div>
          </div>
        )}

        {reason && <p className="vs-note mt-4 leading-relaxed">{reason}</p>}
      </div>

      {/* 问题列表 */}
      <div className="mt-2 space-y-6">
        {questions.map((q, idx) => {
          const current = answers[q.dimension]
          return (
            <div key={q.dimension} className="vs-sec">
              <div className="flex items-start gap-3">
                <span className="vs-num shrink-0 text-[var(--vs-ink-4)]">{idx + 1}</span>
                <p className="text-[15px] leading-snug text-[var(--vs-ink)]">{q.question}</p>
              </div>

              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {q.options.map((opt) => {
                  const selected = !current?.isCustom && current?.value === opt
                  return (
                    <button
                      key={opt}
                      type="button"
                      disabled={loading}
                      onClick={() => selectOption(q.dimension, opt)}
                      className={`rounded-[var(--vs-r)] border px-4 py-2.5 text-left text-[14px] transition ${
                        selected
                          ? 'border-[var(--vs-beam-line)] bg-[var(--vs-beam-wash)] text-[var(--vs-ink)]'
                          : 'border-[var(--vs-line)] bg-transparent text-[var(--vs-ink-3)] hover:border-[var(--vs-line-2)] hover:text-[var(--vs-ink)]'
                      } ${loading ? 'opacity-60 cursor-not-allowed' : ''}`}
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
                        className="vs-link"
                      >
                        其他（自定义输入）
                      </button>
                    ) : (
                      <input
                        type="text"
                        value={customTexts[q.dimension] ?? current?.value ?? ''}
                        onChange={(e) => setCustomValue(q.dimension, e.target.value)}
                        disabled={loading}
                        placeholder="输入你的回答"
                        className="vs-input vs-input-field"
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
      <div className="mt-6 pt-4 border-t border-[var(--vs-line)] flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onSkip}
          disabled={loading}
          className="vs-link disabled:opacity-50"
        >
          跳过澄清，用 AI 推断直接生成
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!allAnswered || loading}
          className="vs-btn vs-btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? '生成方案中…' : '使用回答，生成方案'}
        </button>
      </div>
    </section>
  )
}
