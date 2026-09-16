'use client'

// ============================================================
// InterviewDialog —— AI 创作者访谈弹窗
//
// 设计原则：
//   1. 单页弹窗，不开新路由（避免打断用户当前流程）
//   2. 一次展示所有 10 问，支持中途保存
//   3. 选择式问题为主，每个问题都允许自定义输入
//   4. 用户可"跳过"（7 天后才会再提醒），可"完成"（写入 declaration）
//   5. 完成后立即触发 onCompleted 回调，调用方决定后续动作
// ============================================================

import { useEffect, useState } from 'react'
import {
  INTERVIEW_QUESTIONS,
  type InterviewQuestion,
} from '@/lib/creative/interviewQuestions'
import type { DeclarationDimension } from '@/lib/creative/creatorDeclaration'
import { shouldTriggerInterview } from '@/lib/creative/interviewTrigger'

interface InterviewDialogProps {
  /** 访谈弹窗是否打开 */
  open: boolean
  /** 用户登录 token（用于提交回答） */
  accessToken: string | null
  /** 访谈完成回调（无论是否真的完整，都关闭弹窗） */
  onCompleted: () => void
  /** 用户主动关闭弹窗（跳过访谈） */
  onDismiss: () => void
}

interface InterviewStatus {
  interviewed: boolean
  complete: boolean
  declaration: Record<string, string>
}

// ── 回答类型 ───────────────────────────────────────────────
interface Answer {
  dimension: DeclarationDimension
  value: string
  /** 是否为自定义输入（true 时不展示选项高亮） */
  isCustom: boolean
}

export function InterviewDialog({
  open,
  accessToken,
  onCompleted,
  onDismiss,
}: InterviewDialogProps) {
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<InterviewStatus | null>(null)
  const [questions, setQuestions] = useState<InterviewQuestion[]>([])
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // ── 加载问题和当前状态 ────────────────────────────────
  useEffect(() => {
    if (!open) return
    void loadInterview()
  }, [open, accessToken])

  async function loadInterview() {
    if (!accessToken) {
      setError('请先登录')
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/creative/interview', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) throw new Error('加载失败')
      const data = await res.json()
      setQuestions(data.questions ?? [])
      setStatus(data.status ?? null)

      // 回填已有回答
      const existing = data.status?.declaration ?? {}
      const initial: Record<string, Answer> = {}
      for (const q of (data.questions ?? []) as InterviewQuestion[]) {
        const v = existing[q.dimension]
        if (v) {
          const isOption = q.options.some((o) => o.value === v)
          initial[q.id] = {
            dimension: q.dimension,
            value: v,
            isCustom: !isOption,
          }
        }
      }
      setAnswers(initial)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  function selectOption(q: InterviewQuestion, value: string) {
    setAnswers((prev) => ({
      ...prev,
      [q.id]: { dimension: q.dimension, value, isCustom: false },
    }))
  }

  function setCustom(q: InterviewQuestion, value: string) {
    setAnswers((prev) => ({
      ...prev,
      [q.id]: { dimension: q.dimension, value, isCustom: true },
    }))
  }

  function clearAnswer(q: InterviewQuestion) {
    setAnswers((prev) => {
      const next = { ...prev }
      delete next[q.id]
      return next
    })
  }

  // ── 提交回答 ───────────────────────────────────────────
  async function submit(complete: boolean) {
    if (!accessToken) return
    setSubmitting(true)
    setError('')
    try {
      const answerList = Object.values(answers).filter(
        (a) => a.value.trim().length > 0
      )
      const res = await fetch('/api/creative/interview', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          answers: answerList,
          complete,
          source: 'onboarding',
        }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.error ?? '提交失败')
      }
      // 完成后回调
      onCompleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  // ── 跳过访谈（7 天后才会再提醒）────────────────────────
  function handleDismiss() {
    try {
      localStorage.setItem('interview_dismissed_at', String(Date.now()))
    } catch { /* ignore */ }
    onDismiss()
  }

  if (!open) return null

  const answeredCount = Object.values(answers).filter(
    (a) => a.value.trim().length > 0
  ).length
  const canComplete = answeredCount >= 6

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(8px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) handleDismiss()
      }}
    >
      <div
        style={{
          background: 'var(--surface, #1a1a1a)',
          border: '1px solid var(--border, rgba(255,255,255,0.08))',
          borderRadius: '16px',
          width: '100%',
          maxWidth: '640px',
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: '0 16px 48px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ padding: '24px 28px', borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))' }}>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: 'var(--text, #fff)' }}>
            AI 想先认识你一下
          </h2>
          <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted, #888)' }}>
            只需 1 分钟，回答这些问题让 AI 更懂你的创作习惯。回答会持续影响生成质量。
          </p>
        </div>

        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted, #888)' }}>
            加载中...
          </div>
        ) : error && questions.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#e74c3c' }}>
            {error}
          </div>
        ) : (
          <>
            <div style={{ padding: '20px 28px' }}>
              {questions.map((q, idx) => {
                const ans = answers[q.id]
                const selectedValue = ans && !ans.isCustom ? ans.value : ''
                const customValue = ans && ans.isCustom ? ans.value : ''
                return (
                  <div
                    key={q.id}
                    style={{
                      marginBottom: '24px',
                      padding: '16px',
                      background: 'var(--surface-2, rgba(255,255,255,0.02))',
                      border: '1px solid var(--border, rgba(255,255,255,0.06))',
                      borderRadius: '12px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '8px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted, #888)' }}>
                        {idx + 1}.
                      </span>
                      <div>
                        <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text, #fff)' }}>
                          {q.question}
                        </div>
                        {q.hint && (
                          <div style={{ fontSize: '12px', color: 'var(--text-muted, #888)', marginTop: '2px' }}>
                            {q.hint}
                          </div>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
                      {q.options.map((opt) => {
                        const isSelected = selectedValue === opt.value
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => selectOption(q, opt.value)}
                            style={{
                              padding: '8px 14px',
                              fontSize: '13px',
                              borderRadius: '8px',
                              cursor: 'pointer',
                              transition: 'all 0.2s',
                              border: isSelected
                                ? '1px solid var(--accent, #4a9eff)'
                                : '1px solid var(--border, rgba(255,255,255,0.1))',
                              background: isSelected
                                ? 'var(--accent-soft, rgba(74,158,255,0.12))'
                                : 'transparent',
                              color: isSelected
                                ? 'var(--accent, #4a9eff)'
                                : 'var(--text-muted, #ccc)',
                            }}
                            title={opt.description}
                          >
                            {opt.label}
                          </button>
                        )
                      })}
                    </div>

                    {q.allowCustom && (
                      <div style={{ marginTop: '10px' }}>
                        <input
                          type="text"
                          value={customValue}
                          onChange={(e) => setCustom(q, e.target.value)}
                          placeholder="或自定义..."
                          style={{
                            width: '100%',
                            padding: '8px 12px',
                            fontSize: '13px',
                            background: 'transparent',
                            border: '1px solid var(--border, rgba(255,255,255,0.1))',
                            borderRadius: '8px',
                            color: 'var(--text, #fff)',
                            outline: 'none',
                          }}
                        />
                      </div>
                    )}

                    {ans && (
                      <div style={{ marginTop: '8px', fontSize: '12px' }}>
                        <span style={{ color: 'var(--text-muted, #888)' }}>
                          已选：{ans.value}
                        </span>
                        <button
                          type="button"
                          onClick={() => clearAnswer(q)}
                          style={{
                            marginLeft: '8px',
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-muted, #888)',
                            cursor: 'pointer',
                            fontSize: '12px',
                            padding: 0,
                          }}
                        >
                          清除
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {error && (
              <div style={{ padding: '0 28px 12px', color: '#e74c3c', fontSize: '13px' }}>
                {error}
              </div>
            )}

            <div
              style={{
                padding: '16px 28px',
                borderTop: '1px solid var(--border, rgba(255,255,255,0.08))',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ fontSize: '12px', color: 'var(--text-muted, #888)' }}>
                已回答 {answeredCount}/{questions.length} 问
                {!canComplete && answeredCount > 0 && '（至少 6 问才能完成）'}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={handleDismiss}
                  disabled={submitting}
                  style={{
                    padding: '8px 16px',
                    fontSize: '13px',
                    borderRadius: '8px',
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    border: '1px solid var(--border, rgba(255,255,255,0.1))',
                    background: 'transparent',
                    color: 'var(--text-muted, #888)',
                  }}
                >
                  稍后再说
                </button>
                <button
                  type="button"
                  onClick={() => submit(false)}
                  disabled={submitting || answeredCount === 0}
                  style={{
                    padding: '8px 16px',
                    fontSize: '13px',
                    borderRadius: '8px',
                    cursor: submitting || answeredCount === 0 ? 'not-allowed' : 'pointer',
                    border: '1px solid var(--border, rgba(255,255,255,0.1))',
                    background: 'transparent',
                    color: 'var(--text, #ccc)',
                  }}
                >
                  {submitting ? '保存中...' : '保存草稿'}
                </button>
                <button
                  type="button"
                  onClick={() => submit(true)}
                  disabled={submitting || !canComplete}
                  style={{
                    padding: '8px 20px',
                    fontSize: '13px',
                    fontWeight: 500,
                    borderRadius: '8px',
                    cursor: submitting || !canComplete ? 'not-allowed' : 'pointer',
                    border: '1px solid var(--accent, #4a9eff)',
                    background: canComplete ? 'var(--accent, #4a9eff)' : 'transparent',
                    color: canComplete ? '#fff' : 'var(--text-muted, #888)',
                  }}
                >
                  {submitting ? '提交中...' : '完成访谈'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── 触发判断 hook（供页面调用）─────────────────────────────

/**
 * 判断是否需要触发访谈的 hook。
 * 返回 [shouldShow, triggerReason, triggerType]。
 * 页面根据 shouldShow 决定是否渲染 InterviewDialog。
 */
export function useInterviewTrigger(
  isLoggedIn: boolean,
  accessToken: string | null
): {
  shouldShow: boolean
  reason: string
  triggerType: 'first_time' | 'incomplete' | 'version_outdated' | null
  refresh: () => void
} {
  const [shouldShow, setShouldShow] = useState(false)
  const [reason, setReason] = useState('')
  const [triggerType, setTriggerType] = useState<
    'first_time' | 'incomplete' | 'version_outdated' | null
  >(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!isLoggedIn || !accessToken) {
      setShouldShow(false)
      return
    }

    // 检查上次跳过时间，7 天内不重复提醒
    let dismissedAt: number | null = null
    try {
      const v = localStorage.getItem('interview_dismissed_at')
      dismissedAt = v ? Number(v) : null
    } catch { /* ignore */ }

    const now = Date.now()
    if (dismissedAt && now - dismissedAt < 7 * 24 * 60 * 60 * 1000) {
      setShouldShow(false)
      return
    }

    // 调用 API 查询访谈状态
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/creative/interview', {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (!res.ok || cancelled) return
        const data = await res.json()
        if (cancelled) return

        // 用 declaration 判断是否触发
        const result = shouldTriggerInterview(data.status?.declaration)
        if (result.shouldTrigger && result.triggerType) {
          setShouldShow(true)
          setReason(result.reason ?? '')
          setTriggerType(result.triggerType)
        } else {
          setShouldShow(false)
        }
      } catch { /* ignore */ }
    })()

    return () => { cancelled = true }
  }, [isLoggedIn, accessToken, refreshKey])

  function refresh() {
    setRefreshKey((k) => k + 1)
  }

  return { shouldShow, reason, triggerType, refresh }
}
