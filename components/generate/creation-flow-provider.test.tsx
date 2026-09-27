import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  pathname: '/generate',
  getSession: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  getValidSession: vi.fn(),
  startGenerationTask: vi.fn(),
  makeWorkId: vi.fn(() => 'work-test'),
  buildMemory: vi.fn(() => ''),
  fetch: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  usePathname: () => mocks.pathname,
}))

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      getUser: mocks.getUser,
      signOut: mocks.signOut,
    },
  },
  getValidSession: mocks.getValidSession,
}))

vi.mock('@/lib/generationTask', () => ({
  startGenerationTask: mocks.startGenerationTask,
}))

vi.mock('@/lib/works', () => ({
  makeWorkId: mocks.makeWorkId,
}))

vi.mock('@/lib/styleMemory', () => ({
  buildMemorySummaryForTopic: mocks.buildMemory,
}))

import {
  CreationFlowProvider,
  useCreationFlow,
} from './creation-flow-provider'

const STORAGE_KEY = 'vision_creation_flow_v1'

const planResponse = {
  content_type: '观点短文',
  content_type_reason: '适合表达观点',
  target_audience: '内容创作者',
  directions: [
    {
      key: 'A',
      title: '观察角度',
      desc: '从真实体验切入',
      viewpoint: '从创作者体验分析',
      structure: ['提出问题', '展开分析', '给出结论'],
      emotion_curve: '平静到明确',
      opening_hook: '从一个问题开始',
      core_conflict: '表达与理解的差异',
      ending: '回到创作本身',
      strategy: '以具体经验支撑观点',
      language_style: { pace: '舒缓', mood: '克制', expression: '分析' },
    },
  ],
  recommended_direction_key: 'A',
  word_count_options: [600, 800, 1200],
  recommended_word_count: 800,
  personal_reason: '',
}

const inspirationResponse = {
  raw_input: '创作与记忆',
  input_type: '主题',
  value_assessment: {
    overall_score: 8,
    competition_level: 5,
    competition_reason: '存在讨论空间',
    content_domain: '创作',
    what_it_is: '关于创作的主题',
    core_theme: '创作与记忆',
    creation_value: '有表达价值',
    freshness: '角度可继续细化',
    discussability: '具有讨论空间',
    differentiation: '可以结合个人经历',
    issues: [],
  },
  optimization_suggestions: {
    main_problem: '范围偏大',
    missing_info: [],
    missing_viewpoints: [],
    improvement_direction: '缩小到一个具体场景',
    optimized_topic: '为什么创作总从记忆开始',
  },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function Harness() {
  const creation = useCreationFlow()
  return (
    <div>
      <output data-testid="hydrated">{String(creation.hydrated)}</output>
      <output data-testid="auth-ready">{String(creation.account.authReady)}</output>
      <output data-testid="stage">{creation.flow.stage}</output>
      <output data-testid="status">{creation.flow.analysisStatus}</output>
      <output data-testid="error">{creation.flow.error}</output>
      <output data-testid="word-count">
        {creation.flow.wordCount === null ? 'null' : String(creation.flow.wordCount)}
      </output>
      <button type="button" onClick={() => creation.setTopic('创作与记忆')}>
        填写主题
      </button>
      <button type="button" onClick={() => creation.setWordCount(1500)}>
        设置字数
      </button>
      <button type="button" onClick={() => creation.beginPlanAnalysis()}>
        开始分析
      </button>
      <button type="button" onClick={creation.beginInspirationAnalysis}>
        分析灵感
      </button>
      <button type="button" onClick={() => void creation.runPendingAnalysis()}>
        执行任务
      </button>
      <button type="button" onClick={creation.retryAnalysis}>
        重试
      </button>
      <button type="button" onClick={creation.startCreationFromInspiration}>
        从灵感开始创作
      </button>
      <button type="button" onClick={creation.cancelAnalysis}>
        返回入口
      </button>
    </div>
  )
}

function renderFlow() {
  return render(
    <CreationFlowProvider>
      <Harness />
    </CreationFlowProvider>
  )
}

async function waitUntilReady() {
  await waitFor(() => {
    expect(screen.getByTestId('hydrated')).toHaveTextContent('true')
    expect(screen.getByTestId('auth-ready')).toHaveTextContent('true')
  })
}

describe('CreationFlowProvider 路由任务流', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
    vi.clearAllMocks()
    mocks.pathname = '/generate'
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'valid-token' } },
    })
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mocks.signOut.mockResolvedValue({ error: null })
    mocks.getValidSession.mockResolvedValue({ access_token: 'valid-token' })
    mocks.fetch.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url === '/api/creator-status') {
        return jsonResponse({ level: 'newcomer', percent: 12, signals: { works: 1 } })
      }
      if (url === '/api/user/balance') {
        return jsonResponse({ balance: 100, pointsPerYuan: 20 })
      }
      if (url === '/api/creative/inspiration/analyze') {
        return jsonResponse({ analysis: inspirationResponse, recalled_materials: [] })
      }
      if (url === '/api/creative/plan') {
        return jsonResponse({ plan: planResponse, usedKnowledgeUnits: [] })
      }
      return jsonResponse({})
    })
    vi.stubGlobal('fetch', mocks.fetch)
  })

  it('开始分析只入队一次，并用 push 进入独立分析路由', async () => {
    const user = userEvent.setup()
    renderFlow()
    await waitUntilReady()

    await user.click(screen.getByRole('button', { name: '填写主题' }))
    await user.click(screen.getByRole('button', { name: '开始分析' }))
    await user.click(screen.getByRole('button', { name: '开始分析' }))

    expect(mocks.push).toHaveBeenCalledTimes(1)
    expect(mocks.push).toHaveBeenCalledWith('/generate/analyzing?task=plan')
    expect(screen.getByTestId('stage')).toHaveTextContent('analyzing')
    expect(screen.getByTestId('status')).toHaveTextContent('queued')
  })

  it('创作分析完成后替换为独立结果路由，不把结果追加到入口', async () => {
    const user = userEvent.setup()
    renderFlow()
    await waitUntilReady()

    await user.click(screen.getByRole('button', { name: '填写主题' }))
    await user.click(screen.getByRole('button', { name: '开始分析' }))
    await user.click(screen.getByRole('button', { name: '执行任务' }))

    await waitFor(() => {
      expect(screen.getByTestId('stage')).toHaveTextContent('plan')
      expect(mocks.replace).toHaveBeenCalledWith('/generate/result')
    })
    expect(mocks.fetch).toHaveBeenCalledWith(
      '/api/creative/plan',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('灵感价值分析使用同一独立分析页并进入结果路由', async () => {
    const user = userEvent.setup()
    renderFlow()
    await waitUntilReady()

    await user.click(screen.getByRole('button', { name: '填写主题' }))
    await user.click(screen.getByRole('button', { name: '分析灵感' }))
    expect(mocks.push).toHaveBeenCalledWith('/generate/analyzing?task=inspiration')

    await user.click(screen.getByRole('button', { name: '执行任务' }))
    await waitFor(() => {
      expect(screen.getByTestId('stage')).toHaveTextContent('insight')
      expect(mocks.replace).toHaveBeenCalledWith('/generate/result')
    })
    expect(mocks.fetch).toHaveBeenCalledWith(
      '/api/creative/inspiration/analyze',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('刷新结果页时从 sessionStorage 恢复结果状态', async () => {
    mocks.pathname = '/generate/result'
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        topic: '已保存主题',
        mode: 'inspiration',
        stage: 'plan',
        analysisTask: 'plan',
        analysisStatus: 'idle',
        plan: planResponse,
      })
    )

    renderFlow()
    await waitUntilReady()

    expect(screen.getByTestId('stage')).toHaveTextContent('plan')
    expect(screen.getByTestId('status')).toHaveTextContent('idle')
  })

  it('刷新分析页不会自动重复付费请求，需用户确认后重试', async () => {
    mocks.pathname = '/generate/analyzing'
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        topic: '未完成主题',
        mode: 'inspiration',
        stage: 'analyzing',
        analysisTask: 'plan',
        analysisStatus: 'running',
      })
    )

    const user = userEvent.setup()
    renderFlow()
    await waitUntilReady()

    expect(screen.getByTestId('status')).toHaveTextContent('error')
    expect(screen.getByTestId('error')).toHaveTextContent('避免重复消耗')
    expect(mocks.fetch).not.toHaveBeenCalledWith(
      '/api/creative/plan',
      expect.objectContaining({ method: 'POST' })
    )

    await user.click(screen.getByRole('button', { name: '重试' }))
    await user.click(screen.getByRole('button', { name: '执行任务' }))
    await waitFor(() => expect(screen.getByTestId('stage')).toHaveTextContent('plan'))
  })

  it('结果页再次发起分析会重新进入分析路由，而不是停留在结果页', async () => {
    mocks.pathname = '/generate/result'
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        topic: '创作与记忆',
        mode: 'inspiration',
        stage: 'insight',
        analysisTask: null,
        analysisStatus: 'idle',
        inspirationAnalysis: inspirationResponse,
      })
    )

    const user = userEvent.setup()
    renderFlow()
    await waitUntilReady()

    await user.click(screen.getByRole('button', { name: '从灵感开始创作' }))

    expect(mocks.push).toHaveBeenCalledWith('/generate/analyzing?task=plan')
    expect(screen.getByTestId('stage')).toHaveTextContent('analyzing')
    expect(screen.getByTestId('status')).toHaveTextContent('queued')
    expect(mocks.replace).not.toHaveBeenCalledWith('/generate')
  })

  it('自定义目标字数会随方案请求发出，并在刷新后恢复', async () => {
    const user = userEvent.setup()
    renderFlow()
    await waitUntilReady()

    await user.click(screen.getByRole('button', { name: '填写主题' }))
    await user.click(screen.getByRole('button', { name: '设置字数' }))
    expect(screen.getByTestId('word-count')).toHaveTextContent('1500')

    await user.click(screen.getByRole('button', { name: '开始分析' }))
    await user.click(screen.getByRole('button', { name: '执行任务' }))
    await waitFor(() => expect(screen.getByTestId('stage')).toHaveTextContent('plan'))

    const planCall = mocks.fetch.mock.calls.find((call) => call[0] === '/api/creative/plan')
    expect(planCall).toBeTruthy()
    expect(JSON.parse(String(planCall?.[1]?.body))).toMatchObject({ word_count: 1500 })
  })

  it('越界字数一律当作未指定，不写入请求', async () => {
    mocks.pathname = '/generate'
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        topic: '创作与记忆',
        mode: 'inspiration',
        wordCount: 20,
        stage: 'input',
        analysisTask: null,
        analysisStatus: 'idle',
      })
    )

    const user = userEvent.setup()
    renderFlow()
    await waitUntilReady()

    expect(screen.getByTestId('word-count')).toHaveTextContent('null')

    await user.click(screen.getByRole('button', { name: '填写主题' }))
    await user.click(screen.getByRole('button', { name: '开始分析' }))
    await user.click(screen.getByRole('button', { name: '执行任务' }))
    await waitFor(() => expect(screen.getByTestId('stage')).toHaveTextContent('plan'))

    const planCall = mocks.fetch.mock.calls.find((call) => call[0] === '/api/creative/plan')
    expect(planCall).toBeTruthy()
    expect(JSON.parse(String(planCall?.[1]?.body))).not.toHaveProperty('word_count')
  })

  it('分析页返回始终 replace 到入口并清理任务状态', async () => {
    const user = userEvent.setup()
    renderFlow()
    await waitUntilReady()

    await user.click(screen.getByRole('button', { name: '填写主题' }))
    await user.click(screen.getByRole('button', { name: '开始分析' }))
    await user.click(screen.getByRole('button', { name: '返回入口' }))

    expect(mocks.replace).toHaveBeenCalledWith('/generate')
    expect(screen.getByTestId('stage')).toHaveTextContent('input')
    expect(screen.getByTestId('status')).toHaveTextContent('idle')
  })
})
