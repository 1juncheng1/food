'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { makeWorkId } from '@/lib/works'
import { buildMemorySummaryForTopic } from '@/lib/styleMemory'
import { startGenerationTask } from '@/lib/generationTask'
import { getValidSession, supabase } from '@/lib/supabaseClient'
import type { CreationMode } from '@/lib/creative/personalization'
import type { CreatorUnderstanding } from '@/lib/creative/creatorStatus'
import { freezePlan } from '@/lib/creative/planFreeze'
import { clampWordCount } from '@/lib/creative/wordCount'
import type { CreativePlan, FrozenPlan, PlanEdits } from '@/lib/creative/plan'
import type { InjectedUnitSummary } from '@/lib/creative/knowledgeInject'
import type {
  ClarificationAnswer,
  ClarificationDimension,
  ClarificationQuestion,
} from '@/lib/creative/intentClarity'
import type { InspirationAnalysis } from '@/lib/creative/inspirationAnalyzer'
import type { MarketReport } from '@/lib/creative/marketAnalyzer'
import type { MaterialAnnotation } from '@/lib/creative/material'
import type { MaterialSelectorMode } from '@/components/generate/material-selector'
import { INSUFFICIENT_POINTS_MESSAGE, MIN_GENERATION_COST } from '@/lib/balance'

const FLOW_STORAGE_KEY = 'vision_creation_flow_v1'
const ANALYSIS_ROUTE = '/generate/analyzing'

export type CreationStage = 'input' | 'analyzing' | 'clarify' | 'plan' | 'insight' | 'materials'
export type CreationAnalysisTask = 'plan' | 'inspiration' | 'clarifications' | 'skip-clarify'
export type CreationAnalysisStatus = 'idle' | 'queued' | 'running' | 'error'

export interface RecalledMaterialPreview {
  id: string
  preview: string
  similarity: number
}

export interface CreationFlowState {
  version: 1
  topic: string
  mode: CreationMode
  /** 用户自定义目标字数（可选）：null = 交给 AI 按主题判断 */
  wordCount: number | null
  recId: string | null
  stage: CreationStage
  analysisTask: CreationAnalysisTask | null
  analysisStatus: CreationAnalysisStatus
  error: string
  plan: CreativePlan | null
  planKnowledge: InjectedUnitSummary[]
  confirmedPlan: FrozenPlan | null
  clarifyQuestions: ClarificationQuestion[]
  clarifyInferred: Partial<Record<ClarificationDimension, string>>
  clarifyReason: string
  clarifyAnswers: ClarificationAnswer[]
  analyzedTopic: string
  inspirationAnalysis: InspirationAnalysis | null
  pendingInspirationContext: InspirationAnalysis | null
  recalledMaterials: RecalledMaterialPreview[]
  marketReport: MarketReport | null
  marketLoading: boolean
  materialAnnotations: MaterialAnnotation[]
  materialMode: MaterialSelectorMode
}

interface AccountState {
  authReady: boolean
  isLoggedIn: boolean
  accessToken: string | null
  creatorStatus: CreatorUnderstanding | null
  balance: number | null
  pointsPerYuan: number | null
}

interface BeginPlanOptions {
  topic?: string
  inspirationContext?: InspirationAnalysis | null
}

interface CreationFlowContextValue {
  flow: CreationFlowState
  hydrated: boolean
  analysisStep: number
  account: AccountState
  effectiveMode: CreationMode
  setTopic: (topic: string) => void
  selectMode: (mode: CreationMode) => void
  setWordCount: (wordCount: number | null) => void
  clearError: () => void
  beginPlanAnalysis: (options?: BeginPlanOptions) => void
  beginInspirationAnalysis: () => void
  runPendingAnalysis: () => Promise<void>
  retryAnalysis: () => void
  cancelAnalysis: () => void
  goToEntry: () => void
  resetInspiration: () => void
  analyzeMarketOpportunity: () => Promise<void>
  startCreationFromInspiration: () => void
  startCreationFromMarketGap: () => void
  submitClarifications: (answers: ClarificationAnswer[]) => void
  skipClarification: () => void
  handleConfirmPlan: (edits: PlanEdits) => void
  handleConfirmMaterials: (
    annotations: MaterialAnnotation[],
    mode: MaterialSelectorMode
  ) => void
  handleBackFromMaterials: () => void
  handleSolve: () => void
  unlockPlan: () => void
  hasResult: boolean
}

const INITIAL_FLOW: CreationFlowState = {
  version: 1,
  topic: '',
  mode: 'inspiration',
  wordCount: null,
  recId: null,
  stage: 'input',
  analysisTask: null,
  analysisStatus: 'idle',
  error: '',
  plan: null,
  planKnowledge: [],
  confirmedPlan: null,
  clarifyQuestions: [],
  clarifyInferred: {},
  clarifyReason: '',
  clarifyAnswers: [],
  analyzedTopic: '',
  inspirationAnalysis: null,
  pendingInspirationContext: null,
  recalledMaterials: [],
  marketReport: null,
  marketLoading: false,
  materialAnnotations: [],
  materialMode: 'recommended',
}

const INITIAL_ACCOUNT: AccountState = {
  authReady: false,
  isLoggedIn: false,
  accessToken: null,
  creatorStatus: null,
  balance: null,
  pointsPerYuan: null,
}

const VALID_STAGES: readonly CreationStage[] = [
  'input',
  'analyzing',
  'clarify',
  'plan',
  'insight',
  'materials',
]
const VALID_TASKS: readonly CreationAnalysisTask[] = [
  'plan',
  'inspiration',
  'clarifications',
  'skip-clarify',
]
const VALID_STATUSES: readonly CreationAnalysisStatus[] = ['idle', 'queued', 'running', 'error']
const VALID_MATERIAL_MODES: readonly MaterialSelectorMode[] = ['recommended', 'manual', 'none']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readApiError(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback
  return typeof value.error === 'string' && value.error.trim() ? value.error : fallback
}

function restoreFlow(raw: string | null): CreationFlowState | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || value.version !== 1) return null

    const stage = VALID_STAGES.includes(value.stage as CreationStage)
      ? (value.stage as CreationStage)
      : INITIAL_FLOW.stage
    const analysisTask = VALID_TASKS.includes(value.analysisTask as CreationAnalysisTask)
      ? (value.analysisTask as CreationAnalysisTask)
      : null
    const analysisStatus = VALID_STATUSES.includes(value.analysisStatus as CreationAnalysisStatus)
      ? (value.analysisStatus as CreationAnalysisStatus)
      : 'idle'
    const materialMode = VALID_MATERIAL_MODES.includes(value.materialMode as MaterialSelectorMode)
      ? (value.materialMode as MaterialSelectorMode)
      : 'recommended'

    return {
      ...INITIAL_FLOW,
      topic: typeof value.topic === 'string' ? value.topic : '',
      mode: value.mode === 'creator' ? 'creator' : 'inspiration',
      wordCount: clampWordCount(value.wordCount),
      recId: typeof value.recId === 'string' ? value.recId : null,
      stage,
      analysisTask,
      analysisStatus,
      error: typeof value.error === 'string' ? value.error : '',
      plan: isRecord(value.plan) ? (value.plan as unknown as CreativePlan) : null,
      planKnowledge: Array.isArray(value.planKnowledge)
        ? (value.planKnowledge as InjectedUnitSummary[])
        : [],
      confirmedPlan: isRecord(value.confirmedPlan)
        ? (value.confirmedPlan as unknown as FrozenPlan)
        : null,
      clarifyQuestions: Array.isArray(value.clarifyQuestions)
        ? (value.clarifyQuestions as ClarificationQuestion[])
        : [],
      clarifyInferred: isRecord(value.clarifyInferred)
        ? (value.clarifyInferred as Partial<Record<ClarificationDimension, string>>)
        : {},
      clarifyReason: typeof value.clarifyReason === 'string' ? value.clarifyReason : '',
      clarifyAnswers: Array.isArray(value.clarifyAnswers)
        ? (value.clarifyAnswers as ClarificationAnswer[])
        : [],
      analyzedTopic: typeof value.analyzedTopic === 'string' ? value.analyzedTopic : '',
      inspirationAnalysis: isRecord(value.inspirationAnalysis)
        ? (value.inspirationAnalysis as unknown as InspirationAnalysis)
        : null,
      pendingInspirationContext: isRecord(value.pendingInspirationContext)
        ? (value.pendingInspirationContext as unknown as InspirationAnalysis)
        : null,
      recalledMaterials: Array.isArray(value.recalledMaterials)
        ? (value.recalledMaterials as RecalledMaterialPreview[])
        : [],
      marketReport: isRecord(value.marketReport)
        ? (value.marketReport as unknown as MarketReport)
        : null,
      marketLoading: false,
      materialAnnotations: Array.isArray(value.materialAnnotations)
        ? (value.materialAnnotations as MaterialAnnotation[])
        : [],
      materialMode,
    }
  } catch {
    return null
  }
}

function writeFlow(flow: CreationFlowState) {
  try {
    sessionStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify(flow))
  } catch {
    // 会话存储不可用时仍允许当前标签页继续使用。
  }
}

const CreationFlowContext = createContext<CreationFlowContextValue | null>(null)

export function CreationFlowProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [flow, setFlowState] = useState<CreationFlowState>(INITIAL_FLOW)
  const [account, setAccountState] = useState<AccountState>(INITIAL_ACCOUNT)
  const [hydrated, setHydrated] = useState(false)
  const [analysisStep, setAnalysisStep] = useState(0)

  const flowRef = useRef(flow)
  const accountRef = useRef(account)
  const initialPathnameRef = useRef(pathname)
  const hydratedRef = useRef(false)
  const activeTaskRef = useRef<CreationAnalysisTask | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const navigationRef = useRef(false)
  const marketLoadingRef = useRef(false)

  const patchFlow = useCallback(
    (
      update:
        | Partial<CreationFlowState>
        | ((current: CreationFlowState) => CreationFlowState)
    ) => {
      const next = typeof update === 'function' ? update(flowRef.current) : {
        ...flowRef.current,
        ...update,
      }
      flowRef.current = next
      setFlowState(next)
      if (hydratedRef.current) writeFlow(next)
    },
    []
  )

  const patchAccount = useCallback((update: Partial<AccountState>) => {
    const next = { ...accountRef.current, ...update }
    accountRef.current = next
    setAccountState(next)
  }, [])

  const stopProgress = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      await Promise.resolve()
      let next = restoreFlow(sessionStorage.getItem(FLOW_STORAGE_KEY)) ?? { ...INITIAL_FLOW }

      if (next.analysisStatus === 'running') {
        next = {
          ...next,
          analysisStatus: 'error',
          error: '页面刷新中断了本次分析。为避免重复消耗，请确认后再重新分析。',
        }
      }

      if (initialPathnameRef.current === '/generate') {
        const params = new URLSearchParams(window.location.search)
        if (params.get('restore') === '1') {
          try {
            const pending: unknown = JSON.parse(sessionStorage.getItem('pending_gen_form') ?? 'null')
            if (isRecord(pending)) {
              if (typeof pending.topic === 'string' && pending.topic.trim()) {
                next = { ...next, topic: pending.topic }
              }
              if (pending.mode === 'inspiration' || pending.mode === 'creator') {
                next = { ...next, mode: pending.mode }
              }
            }
          } catch {
            // 无可恢复内容时保持当前草稿。
          }
        }

        const topicFromUrl = params.get('topic')
        const recIdFromUrl = params.get('rec_id')
        if (topicFromUrl) next = { ...next, topic: topicFromUrl }
        if (recIdFromUrl) next = { ...next, recId: recIdFromUrl }
      }

      try {
        const savedMode = localStorage.getItem('creation_mode')
        if (savedMode === 'inspiration' || savedMode === 'creator') {
          next = { ...next, mode: savedMode }
        } else if (localStorage.getItem('use_creator_model') === '1') {
          next = { ...next, mode: 'creator' }
        }
      } catch {
        // 本地偏好不可用时使用会话中的模式。
      }

      if (cancelled) return
      flowRef.current = next
      setFlowState(next)
      hydratedRef.current = true
      setHydrated(true)
      writeFlow(next)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (!session?.access_token || cancelled) {
          if (!cancelled) patchAccount({ authReady: true })
          return
        }

        const { error: authError } = await supabase.auth.getUser()
        if (cancelled) return
        if (authError) {
          await supabase.auth.signOut({ scope: 'local' })
          if (!cancelled) patchAccount({ authReady: true })
          return
        }

        patchAccount({
          authReady: true,
          isLoggedIn: true,
          accessToken: session.access_token,
        })

        void fetch('/api/creator-status', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
          .then(async (response) =>
            response.ok ? ((await response.json()) as CreatorUnderstanding) : null
          )
          .then((data) => {
            if (!cancelled && data && typeof data.percent === 'number') {
              patchAccount({ creatorStatus: data })
            }
          })
          .catch(() => {})

        void fetch('/api/user/balance', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
          .then(async (response) =>
            response.ok
              ? ((await response.json()) as {
                  balance: number | null
                  pointsPerYuan?: number
                })
              : null
          )
          .then((data) => {
            if (cancelled || !data) return
            patchAccount({
              balance: typeof data.balance === 'number' ? data.balance : null,
              pointsPerYuan:
                typeof data.pointsPerYuan === 'number' && data.pointsPerYuan > 0
                  ? data.pointsPerYuan
                  : null,
            })
          })
          .catch(() => {})
      } catch {
        if (!cancelled) patchAccount({ authReady: true })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [patchAccount])

  useEffect(() => {
    if (pathname === ANALYSIS_ROUTE) {
      navigationRef.current = false
      return
    }
    if (!activeTaskRef.current) return

    abortRef.current?.abort()
    abortRef.current = null
    activeTaskRef.current = null
    stopProgress()
    patchFlow((current) => ({
      ...current,
      stage: pathname === '/generate' ? 'input' : current.stage,
      analysisStatus: 'idle',
      analysisTask: pathname === '/generate' ? null : current.analysisTask,
    }))
  }, [patchFlow, pathname, stopProgress])

  useEffect(
    () => () => {
      abortRef.current?.abort()
      stopProgress()
    },
    [stopProgress]
  )

  const setTopic = useCallback(
    (topic: string) => patchFlow({ topic, error: '' }),
    [patchFlow]
  )

  const selectMode = useCallback(
    (mode: CreationMode) => {
      patchFlow({ mode, error: '' })
      try {
        localStorage.setItem('creation_mode', mode)
      } catch {
        // 偏好写入失败不影响本次创作。
      }
    },
    [patchFlow]
  )

  const clearError = useCallback(() => patchFlow({ error: '' }), [patchFlow])

  const setWordCount = useCallback(
    (wordCount: number | null) => patchFlow({ wordCount: clampWordCount(wordCount), error: '' }),
    [patchFlow]
  )

  const setEntryError = useCallback(
    (message: string) => patchFlow({ error: message }),
    [patchFlow]
  )

  const canStart = useCallback(
    (checkBalance: boolean): boolean => {
      const currentAccount = accountRef.current
      if (!currentAccount.authReady) {
        setEntryError('创作空间正在准备，请稍候再试')
        return false
      }
      if (!currentAccount.isLoggedIn) {
        setEntryError('登录状态已失效，请重新登录')
        return false
      }
      if (
        checkBalance &&
        currentAccount.balance !== null &&
        currentAccount.balance < MIN_GENERATION_COST
      ) {
        setEntryError(INSUFFICIENT_POINTS_MESSAGE)
        return false
      }
      return true
    },
    [setEntryError]
  )

  const navigateToAnalysis = useCallback(
    (task: CreationAnalysisTask, next: CreationFlowState) => {
      if (navigationRef.current || activeTaskRef.current) return
      navigationRef.current = true
      patchFlow({
        ...next,
        stage: 'analyzing',
        analysisTask: task,
        analysisStatus: 'queued',
        error: '',
      })
      setAnalysisStep(0)
      router.push(`${ANALYSIS_ROUTE}?task=${task}`)
    },
    [patchFlow, router]
  )

  const beginPlanAnalysis = useCallback(
    (options?: BeginPlanOptions) => {
      if (!canStart(true)) return
      const current = flowRef.current
      if (current.analysisStatus === 'queued' || current.analysisStatus === 'running') return
      const topic = (options?.topic ?? current.topic).trim()
      if (!topic) {
        setEntryError('请先填写创作主题')
        return
      }

      try {
        sessionStorage.setItem(
          'pending_gen_form',
          JSON.stringify({ topic, mode: current.mode })
        )
      } catch {
        // 恢复草稿失败不阻断主流程。
      }

      navigateToAnalysis('plan', {
        ...current,
        topic,
        plan: null,
        planKnowledge: [],
        confirmedPlan: null,
        clarifyAnswers: [],
        clarifyQuestions: [],
        clarifyInferred: {},
        clarifyReason: '',
        pendingInspirationContext: options?.inspirationContext ?? null,
      })
    },
    [canStart, navigateToAnalysis, setEntryError]
  )

  const beginInspirationAnalysis = useCallback(() => {
    if (!canStart(false)) return
    const current = flowRef.current
    if (current.analysisStatus === 'queued' || current.analysisStatus === 'running') return
    const topic = current.topic.trim()
    if (!topic) {
      setEntryError('请先填写灵感内容')
      return
    }
    if (topic.length < 2) {
      setEntryError('灵感太短，至少 2 个字')
      return
    }

    navigateToAnalysis('inspiration', {
      ...current,
      topic,
      inspirationAnalysis: null,
      pendingInspirationContext: null,
      recalledMaterials: [],
      marketReport: null,
      marketLoading: false,
    })
  }, [canStart, navigateToAnalysis, setEntryError])

  const runPendingAnalysis = useCallback(async () => {
    const snapshot = flowRef.current
    const currentAccount = accountRef.current
    const task = snapshot.analysisTask
    if (!task || snapshot.analysisStatus !== 'queued' || activeTaskRef.current) return
    if (!currentAccount.authReady) return
    if (!currentAccount.isLoggedIn) {
      patchFlow({ analysisStatus: 'error', error: '登录状态已失效，请返回后重新登录' })
      return
    }

    const topic = snapshot.topic.trim()
    if (!topic) {
      patchFlow({ analysisStatus: 'error', error: '创作主题已丢失，请返回重新输入' })
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    activeTaskRef.current = task
    patchFlow({ analysisStatus: 'running', error: '' })
    setAnalysisStep(0)
    timerRef.current = setInterval(() => {
      setAnalysisStep((step) => Math.min(step + 1, 3))
    }, 2600)

    try {
      const session = await getValidSession()
      if (!session?.access_token) throw new Error('登录状态已失效，请重新登录')
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      }

      if (task === 'inspiration') {
        const response = await fetch('/api/creative/inspiration/analyze', {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({ raw_input: topic }),
        })
        const data: unknown = await response.json().catch(() => null)
        if (!response.ok) throw new Error(readApiError(data, '灵感分析失败，请稍后重试'))
        if (!isRecord(data) || !isRecord(data.analysis)) {
          throw new Error('AI 返回内容不完整，请重试')
        }
        if (controller.signal.aborted || activeTaskRef.current !== task) return

        patchFlow((current) => ({
          ...current,
          stage: 'insight',
          analysisStatus: 'idle',
          inspirationAnalysis: data.analysis as unknown as InspirationAnalysis,
          recalledMaterials: Array.isArray(data.recalled_materials)
            ? (data.recalled_materials as RecalledMaterialPreview[])
            : [],
          marketReport: null,
          marketLoading: false,
        }))
        activeTaskRef.current = null
        router.replace('/generate/result')
        return
      }

      const body: Record<string, unknown> = {
        topic,
        mode: currentAccount.isLoggedIn ? snapshot.mode : 'inspiration',
      }
      // 自定义目标字数：只对方案类任务生效，灵感价值分析不涉字数
      if (snapshot.wordCount !== null) body.word_count = snapshot.wordCount
      if (task === 'plan' && snapshot.pendingInspirationContext) {
        body.inspiration_context = snapshot.pendingInspirationContext
      }
      if (task === 'clarifications') {
        body.clarifications = snapshot.clarifyAnswers
        if (snapshot.recId) body.rec_id = snapshot.recId
      }
      if (task === 'skip-clarify') {
        body.skip_clarify = true
        if (snapshot.recId) body.rec_id = snapshot.recId
      }

      const response = await fetch('/api/creative/plan', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      })
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok) throw new Error(readApiError(data, '创作方案生成失败，请重试'))
      if (!isRecord(data)) throw new Error('AI 返回内容不完整，请重试')
      if (controller.signal.aborted || activeTaskRef.current !== task) return

      if (
        data.stage === 'clarify' &&
        Array.isArray(data.questions) &&
        data.questions.length > 0
      ) {
        patchFlow((current) => ({
          ...current,
          stage: 'clarify',
          analysisStatus: 'idle',
          clarifyQuestions: data.questions as ClarificationQuestion[],
          clarifyInferred: isRecord(data.inferred)
            ? (data.inferred as Partial<Record<ClarificationDimension, string>>)
            : {},
          clarifyReason: typeof data.reason === 'string' ? data.reason : '',
          analyzedTopic: topic,
        }))
        activeTaskRef.current = null
        router.replace('/generate/result')
        return
      }

      if (!isRecord(data.plan)) throw new Error('AI 返回内容不完整，请重试')
      patchFlow((current) => ({
        ...current,
        stage: 'plan',
        analysisStatus: 'idle',
        plan: data.plan as unknown as CreativePlan,
        planKnowledge: Array.isArray(data.usedKnowledgeUnits)
          ? (data.usedKnowledgeUnits as InjectedUnitSummary[])
          : [],
        clarifyAnswers: task === 'clarifications' ? current.clarifyAnswers : [],
        analyzedTopic: topic,
      }))
      activeTaskRef.current = null
      router.replace('/generate/result')
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return
      patchFlow({
        analysisStatus: 'error',
        error: error instanceof Error ? error.message : '网络异常，请重试',
      })
    } finally {
      stopProgress()
      if (activeTaskRef.current === task) activeTaskRef.current = null
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [patchFlow, router, stopProgress])

  const retryAnalysis = useCallback(() => {
    const current = flowRef.current
    if (!current.analysisTask || activeTaskRef.current) return
    patchFlow({ analysisStatus: 'queued', error: '' })
  }, [patchFlow])

  const cancelAnalysis = useCallback(() => {
    const controller = abortRef.current
    abortRef.current = null
    activeTaskRef.current = null
    controller?.abort()
    stopProgress()
    navigationRef.current = false
    patchFlow({
      stage: 'input',
      analysisTask: null,
      analysisStatus: 'idle',
      error: '',
    })
    router.replace('/generate')
  }, [patchFlow, router, stopProgress])

  const goToEntry = useCallback(() => {
    patchFlow({ analysisStatus: 'idle', analysisTask: null, error: '' })
    router.replace('/generate')
  }, [patchFlow, router])

  const resetInspiration = useCallback(() => {
    patchFlow({
      stage: 'input',
      analysisTask: null,
      analysisStatus: 'idle',
      error: '',
      inspirationAnalysis: null,
      pendingInspirationContext: null,
      recalledMaterials: [],
      marketReport: null,
      marketLoading: false,
    })
    router.replace('/generate')
  }, [patchFlow, router])

  const analyzeMarketOpportunity = useCallback(async () => {
    const current = flowRef.current
    if (marketLoadingRef.current || !current.inspirationAnalysis) return
    marketLoadingRef.current = true
    patchFlow({ marketLoading: true, error: '' })

    try {
      const session = await getValidSession()
      if (!session?.access_token) throw new Error('登录状态已失效，请重新登录')
      const analysis = flowRef.current.inspirationAnalysis
      if (!analysis) return
      const response = await fetch('/api/creative/market/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          raw_input: analysis.raw_input,
          competition_level: analysis.value_assessment.competition_level,
          competition_reason: analysis.value_assessment.competition_reason,
          content_domain: analysis.value_assessment.content_domain,
        }),
      })
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok) throw new Error(readApiError(data, '市场分析失败，请重试'))
      if (!isRecord(data) || !isRecord(data.report)) {
        throw new Error('市场分析返回不完整，请重试')
      }
      patchFlow({ marketReport: data.report as unknown as MarketReport })
    } catch (error) {
      patchFlow({ error: error instanceof Error ? error.message : '网络异常，请重试' })
    } finally {
      marketLoadingRef.current = false
      patchFlow({ marketLoading: false })
    }
  }, [patchFlow])

  const startCreationFromStage = useCallback(
    (target: 'inspiration' | 'market') => {
      const current = flowRef.current
      const analysis = current.inspirationAnalysis
      if (!analysis) return

      const context: InspirationAnalysis = current.marketReport
        ? { ...analysis, market_report: current.marketReport }
        : analysis
      const optimizedTopic =
        target === 'market'
          ? current.marketReport?.recommended_topic.trim()
          : analysis.optimization_suggestions.optimized_topic.trim()

      beginPlanAnalysis({
        topic: optimizedTopic || current.topic.trim(),
        inspirationContext: context,
      })
    },
    [beginPlanAnalysis]
  )

  const startCreationFromInspiration = useCallback(
    () => startCreationFromStage('inspiration'),
    [startCreationFromStage]
  )

  const startCreationFromMarketGap = useCallback(
    () => startCreationFromStage('market'),
    [startCreationFromStage]
  )

  const submitClarifications = useCallback(
    (answers: ClarificationAnswer[]) => {
      const current = flowRef.current
      if (!current.analyzedTopic || activeTaskRef.current) {
        setEntryError('主题已失效，请返回重新输入')
        return
      }
      navigateToAnalysis('clarifications', {
        ...current,
        topic: current.analyzedTopic,
        clarifyAnswers: answers,
      })
    },
    [navigateToAnalysis, setEntryError]
  )

  const skipClarification = useCallback(() => {
    const current = flowRef.current
    if (!current.analyzedTopic || activeTaskRef.current) {
      goToEntry()
      return
    }
    navigateToAnalysis('skip-clarify', {
      ...current,
      topic: current.analyzedTopic,
      clarifyAnswers: [],
    })
  }, [goToEntry, navigateToAnalysis])

  const startGeneration = useCallback(
    (
      frozen: FrozenPlan,
      annotations: MaterialAnnotation[],
      materialMode: MaterialSelectorMode
    ) => {
      const current = flowRef.current
      const currentAccount = accountRef.current
      if (!currentAccount.authReady || !currentAccount.isLoggedIn) {
        patchFlow({ error: '登录状态已失效，请重新登录' })
        return
      }
      if (
        currentAccount.balance !== null &&
        currentAccount.balance < MIN_GENERATION_COST
      ) {
        patchFlow({ error: INSUFFICIENT_POINTS_MESSAGE })
        window.scrollTo({ top: 0, behavior: 'smooth' })
        return
      }

      const topic = current.topic.trim()
      const generationId = makeWorkId()
      const wordCount = frozen.word_count ?? current.plan?.recommended_word_count
      const annotationsToPass =
        materialMode === 'none' || current.mode === 'inspiration' ? [] : annotations

      startGenerationTask(
        generationId,
        {
          topic,
          identityLabel: '',
          style: '',
          wordCount: wordCount ?? 800,
          category: '',
          customCategory: '',
          memory: buildMemorySummaryForTopic(topic),
          mode: current.mode,
          plan: frozen,
          inspirationContext: current.inspirationAnalysis ?? undefined,
          materialAnnotations: annotationsToPass,
        },
        {
          title: topic,
          identityLabel: '',
          style: '',
          category: '',
        }
      )
      router.push(`/article/${generationId}`)
    },
    [patchFlow, router]
  )

  const handleConfirmPlan = useCallback(
    (edits: PlanEdits) => {
      const current = flowRef.current
      if (!current.plan) return
      if (current.topic.trim() !== current.analyzedTopic) {
        patchFlow({ error: '题目已修改，请先重新分析后再生成' })
        return
      }

      const frozen = freezePlan(current.plan, edits, current.clarifyAnswers)
      patchFlow({ confirmedPlan: frozen })
      if (current.mode === 'inspiration') {
        startGeneration(frozen, [], 'none')
        return
      }

      patchFlow({
        stage: 'materials',
        materialMode: 'recommended',
        materialAnnotations: [],
      })
    },
    [patchFlow, startGeneration]
  )

  const handleConfirmMaterials = useCallback(
    (annotations: MaterialAnnotation[], materialMode: MaterialSelectorMode) => {
      const current = flowRef.current
      patchFlow({ materialAnnotations: annotations, materialMode })
      if (current.confirmedPlan) {
        startGeneration(current.confirmedPlan, annotations, materialMode)
      }
    },
    [patchFlow, startGeneration]
  )

  const handleBackFromMaterials = useCallback(
    () => patchFlow({ stage: 'plan' }),
    [patchFlow]
  )

  const unlockPlan = useCallback(
    () => patchFlow({ confirmedPlan: null }),
    [patchFlow]
  )

  const handleSolve = useCallback(() => {
    const current = flowRef.current
    if (!current.plan?.problem) return
    if (current.topic.trim() !== current.analyzedTopic) {
      patchFlow({ error: '题目已修改，请先重新分析后再继续' })
      return
    }

    const generationId = makeWorkId()
    try {
      sessionStorage.setItem(
        `pending_solution_${generationId}`,
        JSON.stringify({
          topic: current.analyzedTopic,
          problem: current.plan.problem,
        })
      )
    } catch {
      // 解决方案页仍可自行处理缺少恢复数据的情况。
    }
    router.push(`/solution/${generationId}`)
  }, [patchFlow, router])

  const effectiveMode: CreationMode = account.isLoggedIn ? flow.mode : 'inspiration'
  const hasResult =
    (flow.stage === 'insight' && flow.inspirationAnalysis !== null) ||
    (flow.stage === 'clarify' && flow.clarifyQuestions.length > 0) ||
    (flow.stage === 'plan' && flow.plan !== null) ||
    (flow.stage === 'materials' && flow.confirmedPlan !== null)

  const value = useMemo<CreationFlowContextValue>(
    () => ({
      flow,
      hydrated,
      analysisStep,
      account,
      effectiveMode,
      setTopic,
      selectMode,
      setWordCount,
      clearError,
      beginPlanAnalysis,
      beginInspirationAnalysis,
      runPendingAnalysis,
      retryAnalysis,
      cancelAnalysis,
      goToEntry,
      resetInspiration,
      analyzeMarketOpportunity,
      startCreationFromInspiration,
      startCreationFromMarketGap,
      submitClarifications,
      skipClarification,
      handleConfirmPlan,
      handleConfirmMaterials,
      handleBackFromMaterials,
      handleSolve,
      unlockPlan,
      hasResult,
    }),
    [
      account,
      analysisStep,
      analyzeMarketOpportunity,
      beginInspirationAnalysis,
      beginPlanAnalysis,
      cancelAnalysis,
      clearError,
      effectiveMode,
      flow,
      goToEntry,
      handleBackFromMaterials,
      handleConfirmMaterials,
      handleConfirmPlan,
      handleSolve,
      hasResult,
      hydrated,
      resetInspiration,
      retryAnalysis,
      runPendingAnalysis,
      selectMode,
      setTopic,
      setWordCount,
      skipClarification,
      startCreationFromInspiration,
      startCreationFromMarketGap,
      submitClarifications,
      unlockPlan,
    ]
  )

  return <CreationFlowContext.Provider value={value}>{children}</CreationFlowContext.Provider>
}

export function useCreationFlow(): CreationFlowContextValue {
  const value = useContext(CreationFlowContext)
  if (!value) throw new Error('useCreationFlow must be used inside CreationFlowProvider')
  return value
}
