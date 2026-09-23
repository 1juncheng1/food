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
import { supabase, getValidSession } from '@/lib/supabaseClient'
import {
  CREATION_MODE_META,
  CREATION_MODES,
  type CreationMode,
} from '@/lib/creative/personalization'
import {
  CREATOR_LEVEL_META,
  type CreatorUnderstanding,
} from '@/lib/creative/creatorStatus'
import { freezePlan } from '@/lib/creative/planFreeze'
import type { CreativePlan, FrozenPlan, PlanEdits } from '@/lib/creative/plan'
// import type 在编译后被完全擦除，不会把服务端注入模块打进浏览器包
import type { InjectedUnitSummary } from '@/lib/creative/knowledgeInject'
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
import type { InspirationAnalysis } from '@/lib/creative/inspirationAnalyzer'
import type { MarketReport } from '@/lib/creative/marketAnalyzer'
import { InspirationAnalysisCard } from '@/components/generate/inspiration-analysis-card'
import { LoginGate } from '@/components/login-gate'
import {
  MaterialSelector,
  type MaterialSelectorMode,
} from '@/components/generate/material-selector'
import type { MaterialAnnotation } from '@/lib/creative/material'

type Stage = 'input' | 'analyzing' | 'clarify' | 'plan' | 'insight' | 'materials'

interface RecalledMaterialPreview {
  id: string
  preview: string
  similarity: number
}

const ANALYZING_STEPS = [
  '正在理解你想解决的问题',
  '设计 3 个差异化的创作方向',
  '匹配最适合的叙事结构与语言风格',
]

export default function PromptOptimizerPage() {
  const router = useRouter()
  const [topic, setTopic] = useState('')
  const [error, setError] = useState('')
  const [recId, setRecId] = useState<string | null>(null)

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
  // Creator Knowledge System Phase 3：本次方案实际参考的知识单元（方案态展示）
  const [planKnowledge, setPlanKnowledge] = useState<InjectedUnitSummary[]>([])
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

  // ── AI 灵感分析系统：在 plan 前置增加 insight 态 ──
  // 用户输入任意模糊灵感 → AI 评估价值+优化建议+召回素材 → 一键进入现有 plan 流程
  const [inspirationAnalysis, setInspirationAnalysis] = useState<InspirationAnalysis | null>(null)
  const [recalledMaterials, setRecalledMaterials] = useState<RecalledMaterialPreview[]>([])
  const [inspirationLoading, setInspirationLoading] = useState(false)
  const inspirationAbortRef = useRef<AbortController | null>(null)

  // ── 市场机会分析：insight 态的二级深挖动作（可选，消费灵感分析结论作种子）──
  const [marketReport, setMarketReport] = useState<MarketReport | null>(null)
  const [marketLoading, setMarketLoading] = useState(false)
  // ── 登录引导弹窗：游客点击生成入口时弹出（封堵游客生成）──
  const [loginGateOpen, setLoginGateOpen] = useState(false)

  // ── Material Library 2.0 Phase 4：素材选择步骤状态 ──
  // 含每条素材的本次创作注解（根基角色/临时标签/备注），仅透传给本次生成请求
  const [materialAnnotations, setMaterialAnnotations] = useState<MaterialAnnotation[]>([])
  const [materialMode, setMaterialMode] = useState<MaterialSelectorMode>('recommended')

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
      try {
        if (new URLSearchParams(window.location.search).get('restore') === '1') {
          const raw = sessionStorage.getItem('pending_gen_form')
          if (raw) {
            const f = JSON.parse(raw)
            if (typeof f.topic === 'string' && f.topic) setTopic(f.topic)
            if (f.mode === 'inspiration' || f.mode === 'creator') setMode(f.mode)
          }
        }
      } catch { /* ignore */ }

      {
        const qs = new URLSearchParams(window.location.search)
        const qTopic = qs.get('topic')
        if (qTopic) setTopic(qTopic)
        const qRecId = qs.get('rec_id')
        if (qRecId) setRecId(qRecId)
      }
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
        // 验活：本地缓存的僵尸 token（服务端已注销）不能作为登录依据，
        // 否则创作入口门全部放行、API 却 401。getUser 走服务端校验。
        const { error: authErr } = await supabase.auth.getUser()
        if (cancelled) return
        if (authErr) {
          // 清本设备缓存，保持游客态（创作入口会弹登录引导）
          await supabase.auth.signOut({ scope: 'local' })
          return
        }
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

  // ── AI 灵感分析：前置增量，不替代 plan ──
  // 流程：用户输入模糊灵感 → 调 /api/creative/inspiration/analyze
  // → 显示价值评估+优化建议+召回素材 → 用户确认 → 携带 context 进入现有 plan
  async function analyzeInspiration() {
    if (inspirationLoading) return
    // 封堵游客生成：未登录弹出引导弹窗，不进入分析流程
    if (!isLoggedIn) {
      setLoginGateOpen(true)
      return
    }
    const t = topic.trim()
    if (!t) {
      setError('请先填写灵感内容')
      return
    }
    if (t.length < 2) {
      setError('灵感太短，至少 2 个字')
      return
    }
    setError('')
    setInspirationLoading(true)
    setInspirationAnalysis(null)
    setRecalledMaterials([])
    setMarketReport(null) // 新灵感：清空上一轮市场分析

    const controller = new AbortController()
    inspirationAbortRef.current = controller

    try {
      // 用 getValidSession 而非 getSession：后者只读本地缓存、不做刷新，
      // 而本页从填主题到真正生成往往跨越很久，极易在出发那一刻带上过期 token。
      const session = await getValidSession()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`

      const res = await fetch('/api/creative/inspiration/analyze', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({ raw_input: t }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(data?.error || '灵感分析失败，请稍后重试')
      }
      if (!data?.analysis) {
        throw new Error('AI 返回内容不完整，请重试')
      }
      setInspirationAnalysis(data.analysis as InspirationAnalysis)
      setRecalledMaterials(
        Array.isArray(data.recalled_materials) ? data.recalled_materials : []
      )
      setStage('insight')
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      setError(e instanceof Error ? e.message : '网络异常，请重试')
    } finally {
      setInspirationLoading(false)
    }
  }

  function cancelInspiration() {
    inspirationAbortRef.current?.abort()
    setInspirationLoading(false)
    setInspirationAnalysis(null)
    setRecalledMaterials([])
    setMarketReport(null)
    setStage('input')
  }

  // 用户在 insight 态点"基于这个灵感开始创作"
  // 重置灵感分析卡 → 进入 input 态但保留 topic → 触发 analyze 进入 plan
  // 关键：plan 请求体携带 inspiration_context，让 plan 延续灵感分析结论
  function startCreationFromInspiration() {
    if (!inspirationAnalysis) return
    const t = topic.trim()
    if (!t || t !== inspirationAnalysis.raw_input) {
      // 用户在 insight 态改了 topic：直接以新 topic 走无 context 的 analyze
      setInspirationAnalysis(null)
      setRecalledMaterials([])
      setMarketReport(null)
      void analyze()
      return
    }
    setStage('input')
    // 关键：若用户做了市场深挖，把 market_report 合入 inspiration_context
    // → plan 阶段瞄准内容缺口设计方向 → 一并落 generation_history.inspiration_context
    const analysisWithMarket: InspirationAnalysis = marketReport
      ? { ...inspirationAnalysis, market_report: marketReport }
      : inspirationAnalysis
    // 异步触发 analyze，让 stage 切换先完成
    void analyze(undefined, analysisWithMarket)
  }

  function resetInspiration() {
    setInspirationAnalysis(null)
    setRecalledMaterials([])
    setMarketReport(null)
    setStage('input')
    setTimeout(() => topicInputRef.current?.focus(), 100)
  }

  // ── 市场机会分析：insight 态二级深挖（消费灵感分析的竞争度结论作种子）──
  async function analyzeMarketOpportunity() {
    if (marketLoading || !inspirationAnalysis) return
    setMarketLoading(true)
    setError('')
    try {
      // 用 getValidSession 而非 getSession：后者只读本地缓存、不做刷新，
      // 而本页从填主题到真正生成往往跨越很久，极易在出发那一刻带上过期 token。
      const session = await getValidSession()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`

      const res = await fetch('/api/creative/market/analyze', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          raw_input: inspirationAnalysis.raw_input,
          competition_level: inspirationAnalysis.value_assessment.competition_level,
          competition_reason: inspirationAnalysis.value_assessment.competition_reason,
          content_domain: inspirationAnalysis.value_assessment.content_domain,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(data?.error || '市场分析失败，请重试')
      }
      if (!data?.report) {
        throw new Error('市场分析返回不完整，请重试')
      }
      setMarketReport(data.report as MarketReport)
    } catch (e) {
      setError(e instanceof Error ? e.message : '网络异常，请重试')
    } finally {
      setMarketLoading(false)
    }
  }

  // ── AI 方案分析 ──
  async function analyze(currentTopic?: string, inspiration?: InspirationAnalysis | null) {
    if (analyzingRef.current) return // 防 Enter 连点 / 分析中重复提交
    // 封堵游客生成：未登录弹出引导弹窗，不进入生成流程
    if (!isLoggedIn) {
      setLoginGateOpen(true)
      return
    }
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

    // 失败恢复暂存
    try {
      sessionStorage.setItem('pending_gen_form', JSON.stringify({
        topic: t,
        mode: effectiveMode,
      }))
    } catch { /* ignore */ }

    try {
      // 用 getValidSession 而非 getSession：后者只读本地缓存、不做刷新，
      // 而本页从填主题到真正生成往往跨越很久，极易在出发那一刻带上过期 token。
      const session = await getValidSession()
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
          hints: Object.keys(hints).length ? hints : undefined,
          // AI 灵感分析系统：携带 insight 态用户确认的 analysis
          // 让 plan 阶段的 LLM 延续灵感分析发现的问题与改进方向
          inspiration_context: inspiration ?? undefined,
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
      // Creator Knowledge System Phase 3：本次方案实际参考了哪些知识单元
      setPlanKnowledge(
        Array.isArray(data.usedKnowledgeUnits) ? data.usedKnowledgeUnits : []
      )
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
      // 用 getValidSession 而非 getSession：后者只读本地缓存、不做刷新，
      // 而本页从填主题到真正生成往往跨越很久，极易在出发那一刻带上过期 token。
      const session = await getValidSession()
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
          hints: Object.keys(hints).length ? hints : undefined,
          clarifications: answers,
          rec_id: recId ?? undefined,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || '方案生成失败，请重试')
      if (!data?.plan) throw new Error('AI 返回内容不完整，请重试')
      setPlan(data.plan as CreativePlan)
      // Creator Knowledge System Phase 3：本次方案实际参考了哪些知识单元
      setPlanKnowledge(
        Array.isArray(data.usedKnowledgeUnits) ? data.usedKnowledgeUnits : []
      )
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
      // 用 getValidSession 而非 getSession：后者只读本地缓存、不做刷新，
      // 而本页从填主题到真正生成往往跨越很久，极易在出发那一刻带上过期 token。
      const session = await getValidSession()
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
          hints: Object.keys(hints).length ? hints : undefined,
          skip_clarify: true,
          rec_id: recId ?? undefined,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || '创作方案生成失败，请重试')
      if (!data?.plan) throw new Error('AI 返回内容不完整，请重试')
      setPlan(data.plan as CreativePlan)
      // Creator Knowledge System Phase 3：本次方案实际参考了哪些知识单元
      setPlanKnowledge(
        Array.isArray(data.usedKnowledgeUnits) ? data.usedKnowledgeUnits : []
      )
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

  // ── 内部：真正启动生成（抽出避免 handleConfirmPlan / handleConfirmMaterials 重复）──
  // 显式接收 frozen 参数：避免依赖闭包中的 confirmedPlan state（React 异步更新时序陷阱）
  function startGenWithParams(
    frozen: FrozenPlan,
    annotations: MaterialAnnotation[],
    modeLabel: MaterialSelectorMode
  ) {
    const t = topic.trim()
    const genId = makeWorkId()
    const memory = buildMemorySummaryForTopic(t)
    const wordCount = frozen.word_count ?? plan?.recommended_word_count

    // 灵感模式跳过素材选择 → modeLabel 永远 'none'；不传素材注解
    const annotationsToPass =
      modeLabel === 'none' || effectiveMode === 'inspiration' ? [] : annotations

    startGenerationTask(
      genId,
      {
        topic: t,
        identityLabel: '',
        style: '',
        wordCount: wordCount ?? 800,
        category: '',
        customCategory: '',
        memory,
        mode: effectiveMode,
        plan: frozen,
        inspirationContext: inspirationAnalysis ?? undefined,
        // Material Library 2.0 Phase 4：素材选择步骤确认的素材（含根基/标签/备注注解）
        materialAnnotations: annotationsToPass,
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

  // ── 方案确认：冻结后根据创作模式分流 ──
  function handleConfirmPlan(edits: PlanEdits) {
    if (!plan) return
    const t = topic.trim()
    if (t !== analyzedTopic) {
      setError('题目已修改，请先点击「重新分析」为新题目生成方案')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    const frozen = freezePlan(plan, edits, clarifyAnswers)
    setConfirmedPlan(frozen)

    //灵感模式：跳过素材选择，直接生成（灵感模式 prompt-optimizer 整块跳过素材检索）
    //关键：显式传 frozen，避免 startGenWithParams 读到旧的 confirmedPlan=null
    if (effectiveMode === 'inspiration') {
      startGenWithParams(frozen, [], 'none')
      return
    }

    // 我的模式：先进入素材选择步骤
    setMaterialMode('recommended')
    setMaterialAnnotations([])
    setStage('materials')
  }

  // ── 素材选择确认：用户在 MaterialSelector 里选完后回调 ──
  function handleConfirmMaterials(
    annotations: MaterialAnnotation[],
    modeLabel: MaterialSelectorMode
  ) {
    setMaterialAnnotations(annotations)
    setMaterialMode(modeLabel)
    // 此时 confirmedPlan 在 handleConfirmPlan 中已 setConfirmedPlan 并经过一次完整渲染，
    // 必为非空；保留判空以兜底异常路径（如用户绕过流程直接触发）
    if (confirmedPlan) {
      startGenWithParams(confirmedPlan, annotations, modeLabel)
    }
  }

  // ── 素材选择返回：回到方案态，用户可调整方案后再来选 ──
  function handleBackFromMaterials() {
    setStage('plan')
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
        {/* 灵感模式：暗夜微光雾（流星划过时的氛围底） */}
        <div className="gm-nebula" />
        {/* 满天繁星（两模式共用，我的模式下更密更亮） */}
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
        {/* 流星（仅灵感模式）：黑夜中划落的灵感 */}
        <i className="gm-meteor" style={{ '--m-top': '-4%', '--m-left': '22%', '--dur': '7s', '--delay': '-2s', '--dx': '-260px', '--dy': '380px', '--len': '90px' } as React.CSSProperties} />
        <i className="gm-meteor" style={{ '--m-top': '-2%', '--m-left': '66%', '--dur': '9s', '--delay': '-6s', '--dx': '-300px', '--dy': '430px', '--len': '110px' } as React.CSSProperties} />
        <i className="gm-meteor" style={{ '--m-top': '4%', '--m-left': '92%', '--dur': '8s', '--delay': '-4s', '--dx': '-240px', '--dy': '350px', '--len': '80px' } as React.CSSProperties} />
        <i className="gm-meteor" style={{ '--m-top': '-6%', '--m-left': '44%', '--dur': '10s', '--delay': '-9s', '--dx': '-280px', '--dy': '400px', '--len': '100px' } as React.CSSProperties} />
        <i className="gm-meteor" style={{ '--m-top': '-8%', '--m-left': '80%', '--dur': '11s', '--delay': '-3s', '--dx': '-200px', '--dy': '320px', '--len': '70px' } as React.CSSProperties} />
        <i className="gm-meteor" style={{ '--m-top': '2%', '--m-left': '10%', '--dur': '8.5s', '--delay': '-7s', '--dx': '-320px', '--dy': '460px', '--len': '120px' } as React.CSSProperties} />
      </div>
      <div className="inner-container gen-sheet">
        {/* ── 页眉：左对齐 ── */}
        <div className="inner-header">
          <div>
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
                <>基于平台通用的高完播创作经验给你建议，登录后 AI 会结合你的创作者人格与历史作品给更精准建议</>
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
            disabled={stage === 'analyzing' || inspirationLoading}
            className="gen-submit btn-shine w-full py-4 rounded-2xl font-semibold text-base text-white transition disabled:opacity-60"
          >
            {stage === 'analyzing'
              ? 'AI 正在分析…'
              : stage === 'plan'
                ? '重新分析'
                : '开始分析'}
          </button>

          {/* AI 灵感分析系统：在主行动按钮下方的次行动入口 */}
          {/* 设计原则：与"开始分析"区分——"开始分析"直接进 plan；"分析灵感"先进 insight 态做价值评估 */}
          <button
            type="button"
            onClick={() => void analyzeInspiration()}
            disabled={stage === 'analyzing' || inspirationLoading || !topic.trim()}
            className="w-full py-3 mt-2 rounded-2xl text-sm font-medium text-indigo-200 border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 hover:border-indigo-500/50 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {inspirationLoading ? 'AI 正在分析灵感…' : '✨ 先分析这个灵感值不值得做'}
          </button>
          <p className="text-[11px] text-zinc-600 mt-2 text-center">
            模糊想法 / 标题 / 一句话 / 新闻都行——AI 先评估价值与差异化，再决定要不要做
          </p>
        </form>

        {/* ── 灵感分析态：AI 评估价值+优化建议+召回素材，用户确认后进入 plan ── */}
        {stage === 'insight' && inspirationAnalysis && (
          <div className="gen-insight-wrapper glass anim-rise">
            <InspirationAnalysisCard
              analysis={inspirationAnalysis}
              recalledMaterials={recalledMaterials}
              marketReport={marketReport}
              marketLoading={marketLoading}
              onMarketAnalysis={() => void analyzeMarketOpportunity()}
              onStartCreation={startCreationFromInspiration}
              onReset={resetInspiration}
              loading={false}
            />
            <button
              type="button"
              onClick={cancelInspiration}
              className="mt-4 text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700 px-4 py-2 rounded-lg transition"
            >
              取消
            </button>
          </div>
        )}

        {/* 灵感分析加载态（独立于 plan 的 analyzing） */}
        {inspirationLoading && stage !== 'insight' && (
          <div className="gen-status glass anim-rise">
            <div className="mx-auto w-12 h-12 rounded-full border-2 border-indigo-500/30 border-t-indigo-400 animate-spin" />
            <h2 className="text-base font-medium text-white mt-6">正在评估这个灵感</h2>
            <p className="text-xs text-zinc-500 mt-2">
              AI 客观判断价值、差异化与提升方向
            </p>
            <button
              type="button"
              onClick={cancelInspiration}
              className="mt-8 text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700 px-4 py-2 rounded-lg transition"
            >
              取消
            </button>
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
              knowledgeUnits={planKnowledge}
              confirmed={!!confirmedPlan}
              onConfirm={handleConfirmPlan}
              onReanalyze={() => { void analyze() }}
              onSolve={handleSolve}
              onBack={backToTopic}
              onBackToEdit={() => setConfirmedPlan(null)}
            />
          </div>
        )}

        {/* ── Material Library 2.0 Phase 4：素材选择步骤（仅我的模式 / creator 模式出现）── */}
        {stage === 'materials' && confirmedPlan && effectiveMode !== 'inspiration' && (
          <div className="gen-plan anim-rise">
            <MaterialSelector
              topic={topic.trim()}
              blueprintUsageTag={
                (confirmedPlan as unknown as { usage_tag?: string | undefined })
                  .usage_tag ?? null
              }
              blueprintContentType={
                (confirmedPlan as unknown as { content_type?: string | undefined })
                  .content_type ?? null
              }
              accessToken={accessToken ?? ''}
              onConfirm={handleConfirmMaterials}
              onBack={handleBackFromMaterials}
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

        {/* ── 登录引导弹窗：游客点击生成入口时弹出 ── */}
        {loginGateOpen && <LoginGate onClose={() => setLoginGateOpen(false)} />}
      </div>
    </div>
  )
}
