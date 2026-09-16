'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getValidSession } from '@/lib/supabaseClient'
import Link from 'next/link'
import {
  type KnowledgeItem,
  extractKnowledgeTraits,
} from '@/lib/creative/knowledgeItem'
import type { KnowledgeClarificationQuestion } from '@/lib/creative/knowledgeAnalyzer'

type Stage = 'idle' | 'analyzing' | 'clarify' | 'confirming' | 'saving' | 'done'

interface ClarifyAnswer {
  question_id: string
  answer: string
  isCustom: boolean
}

export default function AddPage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<'text' | 'image'>('text')
  const [content, setContent] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState('')

  // ── AI 理解状态机 ──
  const [stage, setStage] = useState<Stage>('idle')
  const [questions, setQuestions] = useState<KnowledgeClarificationQuestion[]>([])
  const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, ClarifyAnswer>>({})
  const [knowledge, setKnowledge] = useState<KnowledgeItem | null>(null)
  const [degraded, setDegraded] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  // ── 用户纠错（最多 2 轮）──
  const [retryCount, setRetryCount] = useState(0)
  const [correctionInput, setCorrectionInput] = useState('')
  const [showCorrection, setShowCorrection] = useState(false)
  const MAX_RETRY = 2

  useEffect(() => {
    async function checkUser() {
      const session = await getValidSession()
      if (!session) router.replace('/login')
    }
    checkUser()
  }, [router])

  function handleSelectFile(selected: File) {
    if (preview) URL.revokeObjectURL(preview)
    setFile(selected)
    setPreview(URL.createObjectURL(selected))
  }

  function clearPreview() {
    if (preview) URL.revokeObjectURL(preview)
    setFile(null)
    setPreview('')
  }

  // ── 阶段 A：用户点击"添加" → 调用 AI 分析 ──
  async function handleAnalyze(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSuccess('')

    if (activeTab === 'text') {
      if (!content.trim()) { setError('请输入内容'); return }
    } else {
      if (!file) { setError('请选择图片'); return }
      // 图片上传走原有 /api/upload-image，不走 AI 理解
      await handleImageUpload()
      return
    }

    const session = await getValidSession()
    if (!session) { router.replace('/login'); return }

    setStage('analyzing')
    try {
      const res = await fetch('/api/creative/analyze-knowledge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ content }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || '分析失败'); setStage('idle'); return }

      if (data.stage === 'clarify') {
        setQuestions(data.questions ?? [])
        setClarifyAnswers({})
        setStage('clarify')
      } else if (data.stage === 'ready') {
        setKnowledge(data.knowledge)
        setDegraded(false)
        setStage('confirming')
      } else if (data.stage === 'error' || data.degraded) {
        // 降级：AI 分析不可用，让用户选择是否直接保存
        setDegraded(true)
        setStage('confirming')
      }
    } catch {
      setError('网络错误，请重试')
      setStage('idle')
    }
  }

  // ── 阶段 B：提交回答 → 重新分析 + 保存 ──
  async function handleClarifySubmit() {
    const session = await getValidSession()
    if (!session) { router.replace('/login'); return }

    setStage('analyzing')
    setError('')
    try {
      const answerList = Object.values(clarifyAnswers).filter((a) => a.answer.trim())
      const res = await fetch('/api/creative/analyze-knowledge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          content,
          clarifications: answerList.map((a) => ({
            question_id: a.question_id,
            answer: a.answer,
          })),
          save: false,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || '分析失败'); setStage('clarify'); return }

      if (data.stage === 'ready' && data.knowledge) {
        setKnowledge(data.knowledge)
        setDegraded(false)
        setStage('confirming')
      } else if (data.stage === 'clarify') {
        // AI 还要继续问（罕见，但兜底）
        setQuestions(data.questions ?? [])
        setClarifyAnswers({})
        setStage('clarify')
      } else {
        setDegraded(true)
        setStage('confirming')
      }
    } catch {
      setError('网络错误，请重试')
      setStage('clarify')
    }
  }

  // ── 确认保存 ──
  async function handleConfirmSave() {
    const session = await getValidSession()
    if (!session) { router.replace('/login'); return }

    setStage('saving')
    setError('')
    try {
      const res = await fetch('/api/creative/analyze-knowledge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          content,
          clarifications: Object.values(clarifyAnswers)
            .filter((a) => a.answer.trim())
            .map((a) => ({ question_id: a.question_id, answer: a.answer })),
          save: true,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || '保存失败'); setStage('confirming'); return }

      setSuccess('添加成功！')
      setStage('done')
      setContent('')
      setTimeout(() => router.push('/materials'), 1000)
    } catch {
      setError('网络错误，请重试')
      setStage('confirming')
    }
  }

  // ── 用户纠错：AI 理解有误 → 重新分析 ──
  async function handleReAnalyze() {
    if (!knowledge || retryCount >= MAX_RETRY) return
    if (!correctionInput.trim()) { setError('请说明 AI 哪里理解错了'); return }

    const session = await getValidSession()
    if (!session) { router.replace('/login'); return }

    setStage('analyzing')
    setError('')
    try {
      const res = await fetch('/api/creative/analyze-knowledge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          content,
          mode: 're_analyze',
          previous_knowledge: knowledge,
          correction: correctionInput.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || '重新分析失败'); setStage('confirming'); return }

      if (data.stage === 'ready' && data.knowledge) {
        setKnowledge(data.knowledge)
        setRetryCount((c) => c + 1)
        setCorrectionInput('')
        setShowCorrection(false)
        setStage('confirming')
      } else {
        setError('重新分析失败，请重试或直接保存')
        setStage('confirming')
      }
    } catch {
      setError('网络错误，请重试')
      setStage('confirming')
    }
  }

  // ── 降级时直接保存（无 knowledge）──
  async function handleSaveWithoutAnalysis() {
    const session = await getValidSession()
    if (!session) { router.replace('/login'); return }

    setStage('saving')
    setError('')
    try {
      const res = await fetch('/api/scripts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ content }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || '保存失败'); setStage('confirming'); return }

      setSuccess('添加成功！')
      setStage('done')
      setContent('')
      setTimeout(() => router.push('/materials'), 1000)
    } catch {
      setError('网络错误，请重试')
      setStage('confirming')
    }
  }

  // ── 图片上传（原有逻辑，不走 AI 理解）──
  async function handleImageUpload() {
    if (!file) return
    const session = await getValidSession()
    if (!session) { router.replace('/login'); return }

    setStage('saving')
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/upload-image', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: formData,
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || '上传失败'); setStage('idle'); return }
      setSuccess('添加成功！')
      setStage('done')
      clearPreview()
      setTimeout(() => router.push('/materials'), 1000)
    } catch {
      setError('网络错误，请重试')
      setStage('idle')
    }
  }

  // ── 重置状态 ──
  function resetToIdle() {
    setStage('idle')
    setQuestions([])
    setClarifyAnswers({})
    setKnowledge(null)
    setDegraded(false)
    setError('')
    setSuccess('')
    setRetryCount(0)
    setCorrectionInput('')
    setShowCorrection(false)
  }

  function selectClarifyOption(q: KnowledgeClarificationQuestion, value: string) {
    setClarifyAnswers((prev) => ({
      ...prev,
      [q.id]: { question_id: q.id, answer: value, isCustom: false },
    }))
  }

  function setClarifyCustom(q: KnowledgeClarificationQuestion, value: string) {
    setClarifyAnswers((prev) => ({
      ...prev,
      [q.id]: { question_id: q.id, answer: value, isCustom: true },
    }))
  }

  const traits = knowledge ? extractKnowledgeTraits(knowledge) : []

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-[800px] mx-auto px-6 pt-[60px] pb-[80px]">
        <div className="flex items-center justify-between">
          <Link href="/materials" className="text-sm text-zinc-500 hover:text-white transition">
            ← 返回素材库
          </Link>
          {(stage === 'clarify' || stage === 'confirming') && (
            <button
              type="button"
              onClick={resetToIdle}
              className="text-sm text-zinc-500 hover:text-white transition"
            >
              重新输入
            </button>
          )}
        </div>

        <h1 className="text-2xl font-bold mt-6 mb-10">添加内容</h1>

        <form onSubmit={handleAnalyze} className="space-y-8">
          {/* Tab 切换 */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('text')}
              disabled={stage !== 'idle'}
              className={`flex-1 py-3 rounded-xl text-sm font-medium transition ${
                activeTab === 'text' ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-400'
              } disabled:opacity-50`}
            >
              文本
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('image')}
              disabled={stage !== 'idle'}
              className={`flex-1 py-3 rounded-xl text-sm font-medium transition ${
                activeTab === 'image' ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-400'
              } disabled:opacity-50`}
            >
              图片
            </button>
          </div>

          {/* 内容输入区 */}
          {activeTab === 'text' ? (
            <div>
              <label className="block text-sm text-zinc-400 mb-3">粘贴你喜欢的文案</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                disabled={stage !== 'idle'}
                rows={10}
                className="w-full bg-zinc-900 border border-zinc-800 text-white rounded-xl px-4 py-3.5 outline-none focus:ring-2 focus:ring-indigo-500 resize-y disabled:opacity-50"
                placeholder="粘贴一段你欣赏的解说、故事、读书笔记……"
              />
            </div>
          ) : (
            <div>
              <label className="block text-sm text-zinc-400 mb-3">选择图片（最大5MB）</label>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                disabled={stage !== 'idle'}
                onChange={(e) => {
                  const selected = e.target.files?.[0]
                  if (selected) handleSelectFile(selected)
                }}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3.5 text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-indigo-600 file:text-white disabled:opacity-50"
              />
              {preview && (
                <img src={preview} alt="预览" className="mt-6 max-h-64 rounded-xl mx-auto" />
              )}
            </div>
          )}

          {error && <p className="text-red-400 text-sm">{error}</p>}
          {success && <p className="text-emerald-400 text-sm">{success}</p>}

          {/* ── 状态机各阶段 UI ── */}

          {/* idle：提交按钮 */}
          {stage === 'idle' && (
            <div className="pt-10">
              <button
                type="submit"
                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-3.5 rounded-xl transition"
              >
                添加
              </button>
            </div>
          )}

          {/* analyzing：分析中 */}
          {stage === 'analyzing' && (
            <div className="pt-10">
              <div className="w-full bg-zinc-800 text-zinc-400 font-medium py-3.5 rounded-xl text-center">
                AI 正在理解素材...
              </div>
            </div>
          )}

          {/* clarify：回答问题 */}
          {stage === 'clarify' && questions.length > 0 && (
            <div className="space-y-6 pt-6">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-4">
                <p className="text-sm text-zinc-300 mb-2">AI 需要更多信息来理解这条素材</p>
                <p className="text-xs text-zinc-500">回答这些问题让 AI 更准确地分析素材用途</p>
              </div>

              {questions.map((q, idx) => {
                const ans = clarifyAnswers[q.id]
                const selectedValue = ans && !ans.isCustom ? ans.answer : ''
                const customValue = ans && ans.isCustom ? ans.answer : ''
                return (
                  <div key={q.id} className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-5">
                    <div className="text-sm text-zinc-200 mb-3">
                      <span className="text-zinc-500 mr-2">{idx + 1}.</span>
                      {q.question}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {q.options.map((opt) => {
                        const isSelected = selectedValue === opt
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => selectClarifyOption(q, opt)}
                            className={`text-sm px-3 py-1.5 rounded-lg border transition ${
                              isSelected
                                ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
                                : 'bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:border-zinc-600'
                            }`}
                          >
                            {opt}
                          </button>
                        )
                      })}
                    </div>
                    {q.allowCustom && (
                      <input
                        type="text"
                        value={customValue}
                        onChange={(e) => setClarifyCustom(q, e.target.value)}
                        placeholder="或自定义..."
                        className="w-full mt-3 bg-transparent border border-zinc-700/50 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500/50"
                      />
                    )}
                  </div>
                )
              })}

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={resetToIdle}
                  className="px-5 py-2.5 rounded-xl text-sm border border-zinc-700 text-zinc-400 hover:border-zinc-600 transition"
                >
                  返回
                </button>
                <button
                  type="button"
                  onClick={handleClarifySubmit}
                  disabled={Object.values(clarifyAnswers).filter((a) => a.answer.trim()).length === 0}
                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-medium py-2.5 rounded-xl transition"
                >
                  提交回答
                </button>
              </div>
            </div>
          )}

          {/* confirming：确认 knowledge */}
          {stage === 'confirming' && (
            <div className="space-y-6 pt-6">
              {degraded ? (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl px-6 py-4">
                  <p className="text-sm text-amber-400 mb-2">AI 分析暂时不可用</p>
                  <p className="text-xs text-zinc-500">素材仍可保存，但本次未生成知识结构。保存后可在素材库查看。</p>
                </div>
              ) : knowledge ? (
                <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm text-zinc-200">AI 已理解素材，请确认后保存</p>
                    {retryCount > 0 && (
                      <span className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-0.5">
                        已纠错 {retryCount} 次
                      </span>
                    )}
                  </div>

                  <div className="space-y-3 text-sm">
                    <div>
                      <span className="text-zinc-500">意义：</span>
                      <span className="text-zinc-200">{knowledge.meaning}</span>
                    </div>
                    <div>
                      <span className="text-zinc-500">用途：</span>
                      <span className="text-zinc-200">{knowledge.content_type}</span>
                    </div>
                    {knowledge.creation_usage && (
                      <div>
                        <span className="text-zinc-500">创作用途：</span>
                        <span className="text-zinc-200">{knowledge.creation_usage}</span>
                      </div>
                    )}
                    <div>
                      <span className="text-zinc-500">置信度：</span>
                      <span className={`text-zinc-200 ${(knowledge.confidence ?? 0) >= 0.7 ? 'text-emerald-400' : (knowledge.confidence ?? 0) >= 0.5 ? 'text-amber-400' : 'text-red-400'}`}>
                        {Math.round((knowledge.confidence ?? 0) * 100)}%
                      </span>
                    </div>
                  </div>

                  {/* 6 维标签 */}
                  <div className="mt-4 flex flex-wrap gap-2">
                    {traits.map((t) => (
                      <div key={t.dimension} className="flex items-center gap-1">
                        <span className="text-[11px] text-zinc-500">{t.label}：</span>
                        {t.tags.map((tag) => (
                          <span
                            key={tag}
                            className="text-[11px] px-2 py-0.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>

                  {/* 用户纠错区 */}
                  {retryCount < MAX_RETRY && (
                    <div className="mt-5 pt-4 border-t border-zinc-800">
                      <button
                        type="button"
                        onClick={() => setShowCorrection((v) => !v)}
                        className="text-xs text-zinc-500 hover:text-amber-400 transition"
                      >
                        {showCorrection ? '收起' : 'AI 理解有误？点此指出'}
                      </button>
                      {showCorrection && (
                        <div className="mt-3 space-y-3">
                          <textarea
                            value={correctionInput}
                            onChange={(e) => setCorrectionInput(e.target.value)}
                            rows={3}
                            placeholder="比如：这不是剧情素材，这是用来对比两种创业思路的案例"
                            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-amber-500/30 resize-none"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => { setCorrectionInput(''); setShowCorrection(false) }}
                              className="text-xs px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-500 hover:text-zinc-300 transition"
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              onClick={handleReAnalyze}
                              disabled={!correctionInput.trim()}
                              className="flex-1 text-xs py-1.5 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 disabled:opacity-40 transition"
                            >
                              重新分析（剩余 {MAX_RETRY - retryCount} 次）
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : null}

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={resetToIdle}
                  className="px-5 py-2.5 rounded-xl text-sm border border-zinc-700 text-zinc-400 hover:border-zinc-600 transition"
                >
                  重新输入
                </button>
                {degraded ? (
                  <button
                    type="button"
                    onClick={handleSaveWithoutAnalysis}
                    className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 rounded-xl transition"
                  >
                    直接保存
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleConfirmSave}
                    className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 rounded-xl transition"
                  >
                    确认保存
                  </button>
                )}
              </div>
            </div>
          )}

          {/* saving */}
          {stage === 'saving' && (
            <div className="pt-10">
              <div className="w-full bg-zinc-800 text-zinc-400 font-medium py-3.5 rounded-xl text-center">
                保存中...
              </div>
            </div>
          )}

          {/* done */}
          {stage === 'done' && (
            <div className="pt-10">
              <div className="w-full bg-emerald-500/20 text-emerald-300 font-medium py-3.5 rounded-xl text-center">
                添加成功！返回素材库...
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  )
}
