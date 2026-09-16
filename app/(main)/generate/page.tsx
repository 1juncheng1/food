'use client'

// ============================================================
// 生成页 /generate —— 灵感场重构阶段 B
//
// 两层流程：
//   第一层 输入态：只填主题（唯一必填）+ 模式选择 + 高级设置（折叠）
//   分析态：POST /api/creative/plan，分阶段 skeleton，可取消
//   第二层 方案态：AI 创作建议卡（可改可确认）
//
// 手动生成路径（高级设置内）完整保留：startGenerationTask 旧链路不变。
// 方案确认 → 生成文章的贯通在阶段 C 完成。
// ============================================================

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { CATEGORIES } from '@/lib/constants'
import { makeWorkId } from '@/lib/works'
import { buildMemorySummaryForTopic } from '@/lib/styleMemory'
import { startGenerationTask } from '@/lib/generationTask'
import { supabase } from '@/lib/supabaseClient'
import {
  CREATION_MODE_META,
  CREATION_MODES,
  type CreationMode,
} from '@/lib/creative/personalization'
import {
  CREATOR_LEVEL_META,
  type CreatorUnderstanding,
} from '@/lib/creative/creatorStatus'
import {
  freezePlan,
  type CreativePlan,
  type FrozenPlan,
  type PlanEdits,
} from '@/lib/creative/plan'
import { PlanPanel } from '@/components/generate/plan-panel'
import { ClarifyPanel } from '@/components/generate/clarify-panel'
import {
  InterviewDialog,
  useInterviewTrigger,
} from '@/components/creative/interview-dialog'
import type {
  ClarificationQuestion,
  ClarificationDimension,
} from '@/lib/creative/intentClarity'
import type { ClarificationAnswer } from '@/lib/creative/intentClarity'
import {
  AdvancedSettings,
  type AdvancedSettingsValue,
  type RestoreSettings,
} from '@/components/generate/advanced-settings'

const DEFAULT_SETTINGS: AdvancedSettingsValue = {
  characters: [],
  selectedCharIds: [],
}

type Stage = 'input' | 'analyzing' | 'clarify' | 'plan'

const ANALYZING_STEPS = [
  '正在理解你想解决的问题',
  '设计 3 个差异化的创作方向',
  '匹配最适合的叙事结构与语言风格',
]

export default function PromptOptimizerPage() {
  const router = useRouter()
  const [topic, setTopic] = useState('')
  const [error, setError] = useState('')

  // ── 创作模式 ──
  const [mode, setMode] = useState<CreationMode>('inspiration')
  const [guestPeek, setGuestPeek] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [creatorStatus, setCreatorStatus] = useState<CreatorUnderstanding | null>(null)

  // ── 访谈触发判断（登录后自动检查是否需要首次访谈）──
  const interviewTrigger = useInterviewTrigger(isLoggedIn, accessToken)

  // ── 两层状态机 ──
  const [stage, setStage] = useState<Stage>('input')
  const [plan, setPlan] = useState<CreativePlan | null>(null)
  const [confirmedPlan, setConfirmedPlan] = useState<FrozenPlan | null>(null)
  const [analyzeStep, setAnalyzeStep] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const stepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // ── 阶段 2/3：意图澄清态 ──
  const [clarifyQuestions, setClarifyQuestions] = useState<ClarificationQuestion[]>([])
  const [clarifyInferred, setClarifyInferred] = useState<Partial<Record<ClarificationDimension, string>>>({})
  const [clarifyReason, setClarifyReason] = useState('')
  // 阶段 3：用户提交的澄清回答原始值（跨设备恢复用 + freezePlan 落库用）
  const [clarifyAnswers, setClarifyAnswers] = useState<ClarificationAnswer[]>([])
  // 提交澄清回答后正在加载 plan（按钮态）
  const [clarifyLoading, setClarifyLoading] = useState(false)
  // 题目输入框常驻：分析中禁用、方案态可改（改了即为"脏题目"需重新分析）
  const topicInputRef = useRef<HTMLInputElement>(null)
  const analyzingRef = useRef(false)
  const [analyzedTopic, setAnalyzedTopic] = useState('')

  // ── 高级设置快照 ──
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AdvancedSettingsValue>(DEFAULT_SETTINGS)
  const [restore, setRestore] = useState<RestoreSettings | null>(null)

  // ── 初始化：模式偏好 + URL/query/sessionStorage 恢复 ──
  // localStorage/sessionStorage 为外部数据源，读取放 async 初始化函数内（与项目约定一致）
  useEffect(() => {
    const init = async () => {
      try {
        const saved = localStorage.getItem('creation_mode')
        if (saved === 'inspiration' || saved === 'creator') {
          setMode(saved)
        } else if (localStorage.getItem('use_creator_model') === '1') {
          setMode('creator')
        }
      } catch { /* ignore */ }

      // 恢复来源优先级：sessionStorage（生成失败回填）> URL query（站外跳入）
      let restored: RestoreSettings | null = null
      try {
        if (new URLSearchParams(window.location.search).get('restore') === '1') {
          const raw = sessionStorage.getItem('pending_gen_form')
          if (raw) {
            const f = JSON.parse(raw)
            if (typeof f.topic === 'string' && f.topic) setTopic(f.topic)
            if (f.mode === 'inspiration' || f.mode === 'creator') setMode(f.mode)
            restored = {
              charIds: Array.isArray(f.charIds) ? f.charIds : undefined,
            }
          }
        }
      } catch { /* ignore */ }

      if (!restored) {
        const qs = new URLSearchParams(window.location.search)
        const qTopic = qs.get('topic')
        if (qTopic) setTopic(qTopic)
        restored = {}
      }
      setRestore(restored)
    }
    void init()

    return () => {
      if (stepTimerRef.current) clearInterval(stepTimerRef.current)
      abortRef.current?.abort()
    }
  }, [])

  // ── 登录态 + Creator 理解程度（失败静默）──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (!session?.access_token || cancelled) return
        setIsLoggedIn(true)
        setAccessToken(session.access_token)
        fetch('/api/creator-status', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
          .then(async (r) => (r.ok ? ((await r.json()) as CreatorUnderstanding) : null))
          .then((d) => {
            if (!cancelled && d && typeof d.percent === 'number') setCreatorStatus(d)
          })
          .catch(() => {})
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [])

  function selectMode(next: CreationMode) {
    if (next === 'creator') {
      if (!isLoggedIn) {
        setGuestPeek(true)
        return
      }
      setGuestPeek(false)
      setError('')
      setMode('creator')
      try { localStorage.setItem('creation_mode', 'creator') } catch { /* ignore */ }
      return
    }
    setGuestPeek(false)
    setError('')
    setMode('inspiration')
    try { localStorage.setItem('creation_mode', 'inspiration') } catch { /* ignore */ }
  }

  // 游客后端强制灵感模式（与服务端裁决一致，不信任前端状态）
  const effectiveMode: CreationMode = isLoggedIn ? mode : 'inspiration'
  const creatorMeta = creatorStatus ? CREATOR_LEVEL_META[creatorStatus.level] : null

  // 方案态下题目被改过：旧方案与新题目不匹配，必须重新分析后才能生成
  // 阶段 3：clarify 态和 plan 态都可能因题目修改而"脏"
  const isDirty =
    (stage === 'plan' || stage === 'clarify') &&
    !!analyzedTopic &&
    topic.trim() !== analyzedTopic

  // 方案卡"返回改题目"：题目本就常驻页首，只需滚回顶部并聚焦
  function backToTopic() {
    window.scrollTo({ top: 0, behavior: 'smooth' })
    setTimeout(() => topicInputRef.current?.focus(), 350)
  }

  // ── AI 方案分析 ──
  async function analyze(currentTopic?: string) {
    if (analyzingRef.current) return // 防 Enter 连点 / 分析中重复提交
    const t = (currentTopic ?? topic).trim()
    if (!t) {
      setError('请先填写创作主题')
      return
    }
    analyzingRef.current = true
    setError('')
    setPlan(null)
    setConfirmedPlan(null)
    // 阶段 3：重置上一轮的澄清状态，避免跨轮次污染
    setClarifyAnswers([])
    setClarifyQuestions([])
    setClarifyInferred({})
    setClarifyReason('')
    setAnalyzeStep(0)
    setStage('analyzing')

    // skeleton 分阶段提示（纯感知，不依赖真实进度）
    stepTimerRef.current = setInterval(() => {
      setAnalyzeStep((s) => Math.min(s + 1, ANALYZING_STEPS.length - 1))
    }, 2600)

    const controller = new AbortController()
    abortRef.current = controller

    // 失败恢复暂存（阶段 2：只存角色选择）
    try {
      sessionStorage.setItem('pending_gen_form', JSON.stringify({
        topic: t,
        charIds: settings.selectedCharIds,
        mode: effectiveMode,
      }))
    } catch { /* ignore */ }

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`

      // 阶段 2：不再传 contentType/style hints，AI 方案会自动推断
      const hints: Record<string, never> = {}

      const res = await fetch('/api/creative/plan', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          topic: t,
          mode: effectiveMode,
          characters: settings.characters,
          hints: Object.keys(hints).length ? hints : undefined,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(data?.error || '创作方案生成失败，请重试')
      }
      // ── 阶段 2：两阶段路由响应分支 ──
      if (data?.stage === 'clarify' && Array.isArray(data.questions) && data.questions.length > 0) {
        // 阶段 A：需要澄清，进入 clarify 态
        setClarifyQuestions(data.questions as ClarificationQuestion[])
        setClarifyInferred(
          (data.inferred as Partial<Record<ClarificationDimension, string>>) ?? {}
        )
        setClarifyReason(typeof data.reason === 'string' ? data.reason : '')
        setAnalyzedTopic(t)
        setStage('clarify')
        return
      }
      // 阶段 A 无需澄清 → 直接返回 plan；阶段 B 用户回答后也返回 plan
      if (!data?.plan) throw new Error('AI 返回内容不完整，请重试')
      setPlan(data.plan as CreativePlan)
      // 阶段 3：analyze 直接返回 plan 时无澄清回答
      setClarifyAnswers([])
      setAnalyzedTopic(t)
      setStage('plan')
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        setStage('input')
        return
      }
      setError(e instanceof Error ? e.message : '网络异常，请重试')
      setStage('input')
      setSettingsOpen(true) // 失败自动展开高级设置，手动路径立即可见
    } finally {
      analyzingRef.current = false
      if (stepTimerRef.current) {
        clearInterval(stepTimerRef.current)
        stepTimerRef.current = null
      }
    }
  }

  function cancelAnalyze() {
    abortRef.current?.abort()
    if (stepTimerRef.current) clearInterval(stepTimerRef.current)
    setStage('input')
  }

  // ── 阶段 2：澄清态操作 ──
  // 提交用户回答，走阶段 B（同一 endpoint，带 clarifications）
  async function submitClarifications(answers: ClarificationAnswer[]) {
    if (clarifyLoading) return
    const t = analyzedTopic
    if (!t) {
      setError('主题已失效，请返回重新输入')
      setStage('input')
      return
    }
    setClarifyLoading(true)
    setError('')
    // 复用 analyzing 态的 skeleton 提示
    setStage('analyzing')
    setAnalyzeStep(0)
    stepTimerRef.current = setInterval(() => {
      setAnalyzeStep((s) => Math.min(s + 1, ANALYZING_STEPS.length - 1))
    }, 2600)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`

      // 阶段 2：不再传 contentType/style hints，AI 方案会自动推断
      const hints: Record<string, never> = {}

      const res = await fetch('/api/creative/plan', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          topic: t,
          mode: effectiveMode,
          characters: settings.characters,
          hints: Object.keys(hints).length ? hints : undefined,
          clarifications: answers,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || '方案生成失败，请重试')
      if (!data?.plan) throw new Error('AI 返回内容不完整，请重试')
      setPlan(data.plan as CreativePlan)
      // 阶段 3：保存用户澄清回答原始值，供 freezePlan 落库
      setClarifyAnswers(answers)
      setStage('plan')
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        setStage('clarify')
        return
      }
      setError(e instanceof Error ? e.message : '网络异常，请重试')
      // 回到澄清态而非 input，保留已填问题让用户重试
      setStage('clarify')
    } finally {
      setClarifyLoading(false)
      if (stepTimerRef.current) {
        clearInterval(stepTimerRef.current)
        stepTimerRef.current = null
      }
    }
  }

  // 跳过澄清：用户不想回答，用 AI 推断值或绕过判定直接生成 plan
  // 实现策略：带 skip_clarify=true 重新请求 /api/creative/plan，后端跳过判定层直接生成
  function skipClarification() {
    if (clarifyLoading) return
    const t = analyzedTopic
    if (!t) {
      setStage('input')
      return
    }
    // 重用 analyze 但带特殊 query 标记 —— 实现上单独 fetch 避免改动 analyze 函数签名
    void skipClarifyAndGenerate(t)
  }

  // 与 analyze 同构，但带 skip_clarify=true 让后端跳过判定层
  async function skipClarifyAndGenerate(t: string) {
    if (analyzingRef.current) return
    analyzingRef.current = true
    setError('')
    setPlan(null)
    setConfirmedPlan(null)
    // 阶段 3：跳过澄清前重置（用户选择跳过，clarifications 应为空）
    setClarifyAnswers([])
    setAnalyzeStep(0)
    setStage('analyzing')
    stepTimerRef.current = setInterval(() => {
      setAnalyzeStep((s) => Math.min(s + 1, ANALYZING_STEPS.length - 1))
    }, 2600)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`

      // 阶段 2：不再传 contentType/style hints，AI 方案会自动推断
      const hints: Record<string, never> = {}

      const res = await fetch('/api/creative/plan', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          topic: t,
          mode: effectiveMode,
          characters: settings.characters,
          hints: Object.keys(hints).length ? hints : undefined,
          skip_clarify: true,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || '创作方案生成失败，请重试')
      if (!data?.plan) throw new Error('AI 返回内容不完整，请重试')
      setPlan(data.plan as CreativePlan)
      // 阶段 3：用户跳过澄清，无澄清回答
      setClarifyAnswers([])
      setAnalyzedTopic(t)
      setStage('plan')
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        setStage('clarify')
        return
      }
      setError(e instanceof Error ? e.message : '网络异常，请重试')
      setStage('clarify')
    } finally {
      analyzingRef.current = false
      if (stepTimerRef.current) {
        clearInterval(stepTimerRef.current)
        stepTimerRef.current = null
      }
    }
  }

  function backFromClarify() {
    if (clarifyLoading) return
    setStage('input')
    setTimeout(() => topicInputRef.current?.focus(), 350)
  }

  // ── 方案确认：冻结后直接启动生成，跳转文章页 ──
  function handleConfirmPlan(edits: PlanEdits) {
    if (!plan) return
    const t = topic.trim()
    // 题目已改却沿用旧方案会导致"新题目 + 旧构思"错位，强制先重新分析
    if (t !== analyzedTopic) {
      setError('题目已修改，请先点击「重新分析」为新题目生成方案')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    // 阶段 3：把用户澄清回答传给 freezePlan 落库
    const frozen = freezePlan(plan, edits, clarifyAnswers)
    setConfirmedPlan(frozen)

    const genId = makeWorkId()
    // 按当前主题过滤偏爱范文：避免跨主题污染（如昨天僵尸先生 → 今天商业计划书）
    const memory = buildMemorySummaryForTopic(t)
    const wordCount = frozen.word_count ?? plan.recommended_word_count

    startGenerationTask(
      genId,
      {
        topic: t,
        // 方案驱动：身份/品类/文风/字数全部由 blueprint 派生，前端不再传递
        // 后端 prompt-optimizer 会从 blueprint.persona_hint / content_type / language_style 自动获取
        identityLabel: '',
        style: '',
        wordCount,
        category: '',
        customCategory: '',
        memory,
        mode: effectiveMode,
        characters: settings.characters,
        plan: frozen,
      },
      {
        title: t,
        identityLabel: '',
        style: '',
        category: '',
      }
    )
    router.push(`/article/${genId}`)
  }

  // ── 2a：非创作类问题——携带问题理解跳转解决方案页 ──
  function handleSolve() {
    if (!plan?.problem) return
    const t = topic.trim()
    // 与 confirm 同样的脏题目防护：题目已改则旧问题理解不适用
    if (t !== analyzedTopic) {
      setError('题目已修改，请先点击「重新分析」为新题目生成方案')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    const genId = makeWorkId()
    try {
      sessionStorage.setItem(
        `pending_solution_${genId}`,
        JSON.stringify({ topic: analyzedTopic, problem: plan.problem })
      )
    } catch { /* ignore */ }
    router.push(`/solution/${genId}`)
  }

  // ── 手动设置直接生成（旧链路已删除）──
  // 阶段 2 原则：用户不再手动传递身份/文风/类型，全部由 AI 方案推断。
  // 方案生成失败时后端自动降级为通用创作指令 + topic + characters。

  return (
    <div className="inner-page gen-stage" data-mode={effectiveMode}>
      {/* 模式场景层：灵感=黑夜流星 / 我的=银河身临（aria-hidden 纯装饰） */}
      <div className="gen-mode-ambient" aria-hidden="true">
        <i className="gm-star" style={{ top: '8%', left: '14%' }} />
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
        <i className="gm-meteor" style={{ '--m-top': '-4%', '--m-left': '22%', '--dur': '7s', '--delay': '-2s', '--dx': '-260px', '--dy': '380px', '--len': '90px' } as React.CSSProperties} />
        <i className="gm-meteor" style={{ '--m-top': '-2%', '--m-left': '66%', '--dur': '9s', '--delay': '-6s', '--dx': '-300px', '--dy': '430px', '--len': '110px' } as React.CSSProperties} />
        <i className="gm-meteor" style={{ '--m-top': '4%', '--m-left': '92%', '--dur': '8s', '--delay': '-4s', '--dx': '-240px', '--dy': '350px', '--len': '80px' } as React.CSSProperties} />
        <i className="gm-meteor" style={{ '--m-top': '-6%', '--m-left': '44%', '--dur': '10s', '--delay': '-9s', '--dx': '-280px', '--dy': '400px', '--len': '100px' } as React.CSSProperties} />
      </div>
      <div className="inner-container gen-sheet">
        {/* ── 页眉：居中，如稿纸题头 ── */}
        <div className="inner-header">
          <div className="text-center">
            <Link href="/dashboard" className="inner-back">← 返回主页</Link>
            <span className="gen-eyebrow">智能创作</span>
            <h1 className="inner-header-title">灵感场</h1>
            <p className="inner-header-sub">
              告诉 AI 你想做什么，它先理解你的问题、再给创作方案；你确认方向，它负责表达
            </p>
          </div>
        </div>

        {/* ── 稿纸：题目（作文标题）在三个阶段始终保留，不再随状态卸载 ── */}
        <form
          onSubmit={(e) => { e.preventDefault(); void analyze() }}
          className="gen-paper glass anim-rise"
        >
          {/* 题目（唯一必填） */}
          <div>
            <label htmlFor="gen-topic" className="gen-field-label">
              你想写什么？ <span className="text-red-400">*</span>
            </label>
            <input
              id="gen-topic"
              ref={topicInputRef}
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例：《巨齿鲨2》、最近为什么越来越多人开始戒咖啡、一个北漂十年的朋友回老家了"
              autoFocus
              disabled={stage === 'analyzing'}
              className={`gen-topic-input w-full ${isDirty ? 'is-dirty' : ''}`}
            />
            <p className="gen-hint">
              可以是一个主题，也可以是一个想解决的问题——AI 会先理解问题，再给你完整建议
            </p>
            {isDirty && (
              <p className="gen-dirty">
                题目已修改，点击「重新分析」让 AI 为新题目设计方案
              </p>
            )}
          </div>

          {/* 模式：滑动指示块分段控件（切换时背景氛围同步变换） */}
          <div>
            <div className="gen-mode-row">
              <div className="mode-switch" role="group" aria-label="创作模式">
                <span
                  className="mode-switch-thumb"
                  style={{ transform: `translateX(${(effectiveMode === 'creator' ? 1 : 0) * 100}%)` }}
                  aria-hidden="true"
                />
                {CREATION_MODES.map((m) => {
                  const selected = mode === m
                  const locked = m === 'creator' && !isLoggedIn
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => selectMode(m)}
                      aria-pressed={selected}
                      data-active={selected || undefined}
                      className={`mode-switch-btn flex items-center justify-center gap-2 ${
                        selected ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      <span className="mode-switch-ico" aria-hidden="true">{m === 'inspiration' ? '💡' : '🧠'}</span>
                      <span>{CREATION_MODE_META[m].label}</span>
                      {locked && <span className="text-[10px] opacity-70">🔒</span>}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 模式说明（单行，随选择切换） */}
            <p className="gen-mode-note text-xs text-zinc-500 leading-relaxed">
              {mode === 'creator' && isLoggedIn ? (
                creatorStatus ? (
                  <>
                    {creatorMeta?.label ?? '专属创作助手已就位'} · 理解程度 {creatorStatus.percent}%
                    <span className="text-zinc-600">
                      {' '}— 已创作 {creatorStatus.signals.works} 篇 · 结合你的创作者人格、素材库与历史作品
                    </span>
                  </>
                ) : (
                  <>结合你的创作者人格、素材库与历史作品创作，你写得越多，它越像你</>
                )
              ) : (
                <>基于平台通用的高完播创作经验给你建议，不读取任何个人数据，无需登录即可使用</>
              )}
            </p>

            {/* 游客点"我的模式"：紧凑登录引导（不跳页） */}
            {guestPeek && !isLoggedIn && (
              <div className="gen-guest mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-center">
                <span className="text-base">🔒</span>
                <p className="text-xs text-zinc-400">
                  登录后 AI 才能结合你的创作者人格、素材库与历史作品给建议
                </p>
                <Link
                  href="/login"
                  className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3.5 py-1.5 rounded-lg transition"
                >去登录</Link>
                <button
                  type="button"
                  onClick={() => setGuestPeek(false)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition"
                >继续用灵感模式</button>
              </div>
            )}
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="bg-red-500/10 text-red-300 text-sm rounded-xl p-4 border border-red-500/20 text-center">
              {error}
            </div>
          )}

          {/* 主行动：输入态=开始分析 / 方案态=重新分析 / 分析中=禁用 */}
          <button
            type="submit"
            disabled={stage === 'analyzing'}
            className="gen-submit btn-shine w-full py-4 rounded-2xl font-semibold text-base text-white transition"
          >
            {stage === 'analyzing'
              ? 'AI 正在分析…'
              : stage === 'plan'
                ? '重新分析'
                : '开始分析'}
          </button>
        </form>

        {/* 角色管理（原高级设置折叠区，阶段 2 只保留登场角色） */}
        {stage === 'input' && (
          <div className="gen-advanced">
            <AdvancedSettings
              isLoggedIn={isLoggedIn}
              open={settingsOpen}
              onToggle={() => setSettingsOpen((v) => !v)}
              onChange={setSettings}
              restore={restore}
            />
          </div>
        )}

        {/* ── 分析态：题目保留在稿纸中，状态卡在下方展开 ── */}
        {stage === 'analyzing' && (
          <div className="gen-status glass anim-rise">
            <div className="mx-auto w-12 h-12 rounded-full border-2 border-indigo-500/30 border-t-indigo-400 animate-spin" />
            <h2 className="text-base font-medium text-white mt-6">正在为你的题目设计创作方案</h2>

            <ul className="mt-7 space-y-3 text-left max-w-sm mx-auto">
              {ANALYZING_STEPS.map((label, i) => {
                const state =
                  i < analyzeStep ? 'done' : i === analyzeStep ? 'active' : 'pending'
                return (
                  <li key={label} className="flex items-center gap-3 text-sm">
                    <span
                      className={`shrink-0 w-5 h-5 rounded-full text-[10px] flex items-center justify-center transition-colors duration-300 ${
                        state === 'done'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : state === 'active'
                            ? 'bg-indigo-500/20 text-indigo-300'
                            : 'bg-zinc-800 text-zinc-600'
                      }`}
                    >
                      {state === 'done' ? '✓' : i + 1}
                    </span>
                    <span
                      className={`transition-colors duration-300 ${
                        state === 'pending' ? 'text-zinc-600' : 'text-zinc-300'
                      }`}
                    >
                      {label}
                      {state === 'active' && <span className="animate-pulse">…</span>}
                    </span>
                  </li>
                )
              })}
            </ul>

            <button
              type="button"
              onClick={cancelAnalyze}
              className="mt-8 text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700 px-4 py-2 rounded-lg transition"
            >
              取消分析
            </button>
            <p className="text-[11px] text-zinc-600 mt-3">
              首次分析需要设计完整方案，通常需要 10-40 秒
            </p>
          </div>
        )}

        {/* ── 澄清态：AI 已识别部分信息，就关键缺口提问 ── */}
        {stage === 'clarify' && clarifyQuestions.length > 0 && (
          <div className="gen-clarify anim-rise">
            <ClarifyPanel
              topic={analyzedTopic}
              questions={clarifyQuestions}
              inferred={clarifyInferred}
              reason={clarifyReason}
              onSubmit={submitClarifications}
              onSkip={skipClarification}
              onBack={backFromClarify}
              loading={clarifyLoading}
            />
          </div>
        )}

        {/* ── 方案态：题目如作文标题留在页首，方案像正文一样在下方展开 ── */}
        {stage === 'plan' && plan && (
          <div className="gen-plan anim-rise">
            <PlanPanel
              plan={plan}
              topic={analyzedTopic}
              confirmed={!!confirmedPlan}
              onConfirm={handleConfirmPlan}
              onReanalyze={() => { void analyze() }}
              onSolve={handleSolve}
              onBack={backToTopic}
              onBackToEdit={() => setConfirmedPlan(null)}
            />
          </div>
        )}

        {/* ── 创作者访谈弹窗（登录后首次使用触发，7 天内跳过不重弹）── */}
        <InterviewDialog
          open={interviewTrigger.shouldShow}
          accessToken={accessToken}
          onCompleted={() => interviewTrigger.refresh()}
          onDismiss={() => interviewTrigger.refresh()}
        />
      </div>
    </div>
  )
}
