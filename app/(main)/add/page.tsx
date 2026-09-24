'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { getValidSession } from '@/lib/supabaseClient'
import Link from 'next/link'
import { AiStatus, PageHeader } from '@/components/vision'
import {
  type KnowledgeItem,
  extractKnowledgeTraits,
} from '@/lib/creative/knowledgeItem'
import type { KnowledgeClarificationQuestion } from '@/lib/creative/knowledgeAnalyzer'
import {
  MATERIAL_TYPES,
  MATERIAL_TYPE_RULES,
  type MaterialType,
  type MaterialSource,
  type MaterialGroup,
} from '@/lib/creative/material'

const SOURCE_OPTIONS: MaterialSource[] = ['手输', '上传', '外部链接', 'AI生成']

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

  // ── Phase 2：素材元数据（materialType / 分组 / 来源）──
  const [materialType, setMaterialType] = useState<MaterialType>('其他')
  const [groupId, setGroupId] = useState<string | ''>('')
  const [source, setSource] = useState<MaterialSource>('手输')
  const [groups, setGroups] = useState<MaterialGroup[]>([])

  useEffect(() => {
    async function checkUser() {
      const session = await getValidSession()
      if (!session) {
        router.replace('/login')
        return
      }
      // 顺带拉取分组列表（用于确认阶段的下拉）
      try {
        const res = await fetch('/api/material-groups', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const data = await res.json()
        if (res.ok) setGroups(data.groups ?? [])
      } catch {
        // 静默失败：分组加载失败不阻断添加流程
      }
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
          // 回传用户刚确认的 AI 分析结果：服务端清洗后直接入库，不再重复调用 LLM
          knowledge: knowledge ?? undefined,
          clarifications: Object.values(clarifyAnswers)
            .filter((a) => a.answer.trim())
            .map((a) => ({ question_id: a.question_id, answer: a.answer })),
          save: true,
          materialType,
          groupId: groupId || null,
          source,
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
        body: JSON.stringify({
          content,
          materialType,
          groupId: groupId || null,
          source,
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
    <div className="inner-page gen-stage" data-mode="inspiration">
      {/* 星空氛围层 */}
      <div className="gen-mode-ambient">
        <i className="gm-star" style={{ top: '22%', left: '78%' }} />
        <i className="gm-star" style={{ top: '34%', left: '36%' }} />
        <i className="gm-star" style={{ top: '12%', left: '58%' }} />
        <i className="gm-star" style={{ top: '46%', left: '8%' }} />
        <i className="gm-star" style={{ top: '28%', left: '92%' }} />
        <i className="gm-star" style={{ top: '58%', left: '68%' }} />
        <i className="gm-star" style={{ top: '66%', left: '24%' }} />
        <i className="gm-star" style={{ top: '74%', left: '84%' }} />
        <i className="gm-star" style={{ top: '18%', left: '46%' }} />
        <i className="gm-star" style={{ top: '52%', left: '50%' }} />
        <i className="gm-star" style={{ top: '84%', left: '10%' }} />
        <i className="gm-star" style={{ top: '80%', left: '58%' }} />
        <i className="gm-star" style={{ top: '40%', left: '88%' }} />
        <i className="gm-star" style={{ top: '90%', left: '34%' }} />
        <i className="gm-meteor" style={{ '--m-top': '-4%', '--m-left': '22%', '--dur': '7s', '--delay': '-2s', '--dx': '-260px', '--dy': '380px', '--len': '90px' } as CSSProperties} />
        <i className="gm-meteor" style={{ '--m-top': '-2%', '--m-left': '66%', '--dur': '9s', '--delay': '-6s', '--dx': '-300px', '--dy': '430px', '--len': '110px' } as CSSProperties} />
        <i className="gm-meteor" style={{ '--m-top': '4%', '--m-left': '92%', '--dur': '8s', '--delay': '-4s', '--dx': '-240px', '--dy': '350px', '--len': '80px' } as CSSProperties} />
      </div>

      <div className="inner-container gen-sheet">
        {/* ── 页眉：素材不是收藏，而是 AI 认识你的原始材料 ── */}
        <Link
          href="/materials"
          className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-zinc-500 transition hover:text-zinc-200"
        >
          ← 返回我的素材
        </Link>
        <PageHeader
          eyebrow="知识沉淀"
          title="添加素材"
          description="一段文案、一张图都可以。AI 先理解它的用途和意义，再帮你沉淀成可复用的知识。"
          ai={
            <AiStatus
              task="material"
              active={stage === 'analyzing' || stage === 'saving'}
              variant="bar"
            />
          }
          actions={
            (stage === 'clarify' || stage === 'confirming') ? (
              <button
                type="button"
                onClick={resetToIdle}
                className="shrink-0 rounded-xl border border-white/[0.1] px-3.5 py-2.5 text-[13px] font-medium text-zinc-300 transition hover:border-white/20 hover:text-white"
              >
                重新输入
              </button>
            ) : undefined
          }
        />

        {/* ── 稿纸卡 ── */}
        <form onSubmit={handleAnalyze} className="gen-paper glass anim-rise">
          {/* Tab 切换 */}
          <div>
            <div className="mode-switch" role="group" aria-label="素材类型">
              <span
                className="mode-switch-thumb"
                style={{ transform: `translateX(${(activeTab === 'image' ? 1 : 0) * 100}%)` }}
                aria-hidden="true"
              />
              <button
                type="button"
                onClick={() => setActiveTab('text')}
                disabled={stage !== 'idle'}
                aria-pressed={activeTab === 'text'}
                data-active={activeTab === 'text' || undefined}
                className={`mode-switch-btn flex items-center justify-center gap-2 ${activeTab === 'text' ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <span className="mode-switch-ico">📝</span>
                <span>文本</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('image')}
                disabled={stage !== 'idle'}
                aria-pressed={activeTab === 'image'}
                data-active={activeTab === 'image' || undefined}
                className={`mode-switch-btn flex items-center justify-center gap-2 ${activeTab === 'image' ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <span className="mode-switch-ico">🖼️</span>
                <span>图片</span>
              </button>
            </div>
          </div>

          {/* 内容输入区 */}
          {activeTab === 'text' ? (
            <div>
              <label className="gen-field-label">粘贴你喜欢的文案</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                disabled={stage !== 'idle'}
                rows={10}
                className={`gen-topic-input w-full resize-y ${content ? 'is-dirty' : ''}`}
                style={{ lineHeight: '1.7' }}
                placeholder="粘贴一段你欣赏的解说、故事、读书笔记……"
              />
              <p className="gen-hint">
                AI 会分析素材的意义、用途、风格维度，帮你把碎片信息变成结构化知识
              </p>
            </div>
          ) : (
            <div>
              <label className="gen-field-label">选择图片（最大5MB）</label>
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
              <p className="gen-hint">支持 JPG / PNG / WebP / GIF，上传后自动存入素材库</p>
            </div>
          )}

          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          {success && <p className="text-emerald-400 text-sm text-center">{success}</p>}

          {/* ── 状态机各阶段 ── */}

          {/* idle：提交按钮 */}
          {stage === 'idle' && (
            <div className="pt-2">
              <button type="submit" className="w-full btn-shine bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-3.5 rounded-xl transition">
                添加
              </button>
            </div>
          )}

          {/* analyzing */}
          {stage === 'analyzing' && (
            <div className="pt-2">
              <div className="w-full glass text-zinc-400 font-medium py-3.5 rounded-xl text-center">
                AI 正在理解素材...
              </div>
            </div>
          )}

          {/* clarify */}
          {stage === 'clarify' && questions.length > 0 && (
            <div className="space-y-6">
              <div className="glass rounded-xl px-6 py-4">
                <p className="text-sm text-zinc-300 mb-2">AI 需要更多信息来理解这条素材</p>
                <p className="text-xs text-zinc-500">回答这些问题让 AI 更准确地分析素材用途</p>
              </div>
              {questions.map((q, idx) => {
                const ans = clarifyAnswers[q.id]
                const selectedValue = ans && !ans.isCustom ? ans.answer : ''
                const customValue = ans && ans.isCustom ? ans.answer : ''
                return (
                  <div key={q.id} className="glass rounded-xl px-6 py-5">
                    <div className="text-sm text-zinc-200 mb-3">
                      <span className="text-zinc-500 mr-2">{idx + 1}.</span>
                      {q.question}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {q.options.map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => selectClarifyOption(q, opt)}
                          aria-pressed={selectedValue === opt}
                          className={`text-sm px-3 py-1.5 rounded-lg border transition ${
                            selectedValue === opt
                              ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
                              : 'bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:border-zinc-600'
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
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
                <button type="button" onClick={resetToIdle} className="px-5 py-2.5 rounded-xl text-sm border border-zinc-700 text-zinc-400 hover:border-zinc-600 transition">
                  返回
                </button>
                <button
                  type="button"
                  onClick={handleClarifySubmit}
                  disabled={Object.values(clarifyAnswers).filter((a) => a.answer.trim()).length === 0}
                  className="flex-1 btn-shine bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-medium py-2.5 rounded-xl transition"
                >
                  提交回答
                </button>
              </div>
            </div>
          )}

          {/* confirming */}
          {stage === 'confirming' && (
            <div className="space-y-6">
              {degraded ? (
                <div className="glass rounded-xl px-6 py-4" style={{ borderColor: 'rgba(245, 158, 11, 0.2)' }}>
                  <p className="text-sm text-amber-400 mb-2">AI 分析暂时不可用</p>
                  <p className="text-xs text-zinc-500">素材仍可保存，但本次未生成知识结构。保存后可在素材库查看。</p>
                </div>
              ) : knowledge ? (
                <div className="glass rounded-xl px-6 py-5">
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
                          <span key={tag} className="text-[11px] px-2 py-0.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                  {/* 用户纠错区 */}
                  {retryCount < MAX_RETRY && (
                    <div className="mt-5 pt-4 border-t border-zinc-800">
                      <button type="button" onClick={() => setShowCorrection((v) => !v)} className="text-xs text-zinc-500 hover:text-amber-400 transition">
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
                            <button type="button" onClick={() => { setCorrectionInput(''); setShowCorrection(false) }} className="text-xs px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-500 hover:text-zinc-300 transition">
                              取消
                            </button>
                            <button type="button" onClick={handleReAnalyze} disabled={!correctionInput.trim()} className="flex-1 text-xs py-1.5 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 disabled:opacity-40 transition">
                              重新分析（剩余 {MAX_RETRY - retryCount} 次）
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : null}

              {/* ── Phase 2：素材元数据（materialType / 分组 / 来源）── */}
              <div className="glass rounded-xl px-5 py-5 space-y-5">
                <div>
                  <p className="text-xs text-zinc-400 mb-1">素材类型</p>
                  <p className="text-[11px] text-zinc-500 mb-3">
                    选好后 AI 创作时按对应规则使用（默认「其他」）
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {MATERIAL_TYPES.map((t) => {
                      const sel = materialType === t
                      const rule = MATERIAL_TYPE_RULES[t]
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setMaterialType(t)}
                          data-active={sel || undefined}
                          className={`material-type-badge cursor-pointer transition ${
                            sel ? 'ring-1 ring-offset-2 ring-offset-zinc-900' : ''
                          }`}
                          data-mt={t}
                          title={rule.usageRule}
                        >
                          {rule.label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-zinc-400 mb-1">分组</p>
                    <p className="text-[11px] text-zinc-500 mb-2">归类到已有分组，便于管理</p>
                    <select
                      value={groupId}
                      onChange={(e) => setGroupId(e.target.value)}
                      className="w-full bg-zinc-900/60 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-white outline-none focus:border-indigo-500/50 cursor-pointer"
                    >
                      <option value="">不分组</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <p className="text-xs text-zinc-400 mb-1">来源</p>
                    <p className="text-[11px] text-zinc-500 mb-2">素材来源（默认「手输」）</p>
                    <select
                      value={source}
                      onChange={(e) => setSource(e.target.value as MaterialSource)}
                      className="w-full bg-zinc-900/60 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-white outline-none focus:border-indigo-500/50 cursor-pointer"
                    >
                      {SOURCE_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <button type="button" onClick={resetToIdle} className="px-5 py-2.5 rounded-xl text-sm border border-zinc-700 text-zinc-400 hover:border-zinc-600 transition">
                  重新输入
                </button>
                {degraded ? (
                  <button type="button" onClick={handleSaveWithoutAnalysis} className="flex-1 btn-shine bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 rounded-xl transition">
                    直接保存
                  </button>
                ) : (
                  <button type="button" onClick={handleConfirmSave} className="flex-1 btn-shine bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 rounded-xl transition">
                    确认保存
                  </button>
                )}
              </div>
            </div>
          )}

          {/* saving */}
          {stage === 'saving' && (
            <div className="pt-2">
              <div className="w-full glass text-zinc-400 font-medium py-3.5 rounded-xl text-center">
                保存中...
              </div>
            </div>
          )}

          {/* done */}
          {stage === 'done' && (
            <div className="pt-2">
              <div className="w-full bg-emerald-500/20 text-emerald-300 font-medium py-3.5 rounded-xl text-center border border-emerald-500/30">
                添加成功！返回素材库...
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  )
}
