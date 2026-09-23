'use client'

// ============================================================
// /solution/[id] —— 2a：非内容类问题的解决方案结果页
//
// 数据来源优先级：
//   ① localStorage works（生成完成后的恢复/回访，含全部历史版本）
//   ② sessionStorage pending_solution_[id]（生成页跳入，发起求解）
//   ③ 都没有 → 空态引导回 /generate
//
// 版本模型（2a 迭代能力）：
//   solutionVersions 旧→新排列，末位=最新版；补强版追加新版本不覆盖旧版。
//   「重新生成」= 推翻重来，重置为单一 V1；「生成补强版」= 迭代，追加 V2/V3…。
//   补强版本云端行 id 为 genId::vN（与文章版本 pid::vN 模式一致）。
//
// 登录用户结果由 /api/problem-solve 落库 generation_history（跨设备）；
// 游客由 saveWork 写 localStorage（与作品双写约定一致）。
// ============================================================

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { normalizeProblem, formatProblemForPrompt } from '@/lib/creative/problemFormat'
import type { ProblemUnderstanding, CreativeBlueprint } from '@/lib/creative/blueprint'
import {
  normalizeSolution,
  formatSolutionFullText,
} from '@/lib/creative/solutionFormat'
import type { SolutionResult, SolutionVersion } from '@/lib/creative/problemSolver'
import { getWork, saveWork, patchWork } from '@/lib/works'
import { supabase } from '@/lib/supabaseClient'

type Phase = 'loading' | 'generating' | 'done' | 'missing'
type SolveMode = 'solve' | 'strengthen'

const SOLVING_STEPS = [
  '正在以专属角色身份理解你的问题',
  '正在按核心任务撰写解决方案',
  '正在整理下一步行动与成功自检',
]

const STRENGTHEN_STEPS = [
  '正在对照成功标准审视当前方案',
  '正在定位不足并设计补强',
  '正在撰写补强后的新版方案',
]

interface SolvePayload {
  topic: string
  problem: ProblemUnderstanding
}

export default function SolutionPage() {
  const params = useParams<{ id: string }>()
  const id = params.id

  const [phase, setPhase] = useState<Phase>('loading')
  const [mode, setMode] = useState<SolveMode>('solve')
  const [versions, setVersions] = useState<SolutionVersion[]>([])
  const [activeIdx, setActiveIdx] = useState(0) // 当前查看的版本下标
  const [problem, setProblem] = useState<ProblemUnderstanding | null>(null)
  const [topic, setTopic] = useState('')
  const [step, setStep] = useState(0)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [strengthenError, setStrengthenError] = useState('') // 补强失败不隐藏结果，仅在操作区提示
  // 最近一次求解入参（初始生成失败后的重试按钮用；补强入参由 topic/problem 状态推导）
  const solvePayloadRef = useRef<SolvePayload | null>(null)
  const [solveAttempted, setSolveAttempted] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const solution: SolutionResult | null = versions[activeIdx]?.result ?? null
  const isLatest = activeIdx === versions.length - 1 && versions.length > 0
  const canIterate = phase === 'done' && isLatest && !!problem && !!topic

  /** 登录态请求头（可选鉴权：游客不带 Authorization） */
  async function authHeaders(): Promise<Record<string, string>> {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
    return headers
  }

  /** 阶段进度计时器：每 8s 推进一步，最后一步停住 */
  function startStepTimer(total: number): ReturnType<typeof setInterval> {
    setStep(0)
    return setInterval(() => setStep((s) => Math.min(s + 1, total - 1)), 8000)
  }

  // ── 首次求解 / 重新生成（推翻重来，重置为 V1）──
  async function solve(payload: SolvePayload) {
    setError('')
    setStrengthenError('')
    setSolveAttempted(true)
    setMode('solve')
    setPhase('generating')
    const stepTimer = startStepTimer(SOLVING_STEPS.length)
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/problem-solve', {
        method: 'POST',
        headers: await authHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          topic: payload.topic,
          problem: payload.problem,
          generationId: id,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || '解决方案生成失败，请重试')
      const result = normalizeSolution(data?.solution)
      if (!result) throw new Error('AI 返回内容不完整，请重试')

      const now = new Date().toISOString()
      const v1: SolutionVersion = { result, createdAt: now }
      setVersions([v1])
      setActiveIdx(0)
      setProblem(payload.problem)
      setTopic(payload.topic)
      solvePayloadRef.current = payload
      setPhase('done')

      // 本地持久化（登录用户云端已同步落库；此处保证刷新/回访可用）
      const fullText: string =
        typeof data.fullText === 'string' ? data.fullText : ''
      saveWork({
        id,
        title: result.title,
        content: fullText,
        category: payload.problem.problem_type,
        created_at: now,
        identityLabel: payload.problem.recommended_role,
        topic: payload.topic,
        solution: result,
        solutionVersions: [v1],
        blueprint: { problem_understanding: payload.problem } as unknown as CreativeBlueprint,
      })
      try {
        sessionStorage.removeItem(`pending_solution_${id}`)
      } catch { /* ignore */ }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      setError(e instanceof Error ? e.message : '网络异常，请重试')
      setPhase('missing')
    } finally {
      clearInterval(stepTimer)
    }
  }

  // ── 补强迭代（保留历史，追加 V2/V3…，不覆盖旧版）──
  async function strengthen() {
    const prev = versions[versions.length - 1]
    if (!prev || !topic || !problem) return
    setStrengthenError('')
    setMode('strengthen')
    setPhase('generating')
    const stepTimer = startStepTimer(STRENGTHEN_STEPS.length)
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const nextVersionNumber = versions.length + 1
      const res = await fetch('/api/problem-solve', {
        method: 'POST',
        headers: await authHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          topic,
          problem,
          previousSolution: prev.result,
          generationId: `${id}::v${nextVersionNumber}`,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || '方案补强失败，请重试')
      const result = normalizeSolution(data?.solution)
      if (!result) throw new Error('AI 返回内容不完整，请重试')

      const note = typeof data?.review?.note === 'string' && data.review.note.trim()
        ? String(data.review.note).slice(0, 200)
        : undefined
      const gaps = Array.isArray(data?.review?.gaps)
        ? (data.review.gaps as unknown[])
            .filter((g): g is string => typeof g === 'string' && !!g.trim())
            .slice(0, 4)
            .map((g) => g.slice(0, 200))
        : []

      const next = [
        ...versions,
        { result, createdAt: new Date().toISOString(), note, gaps: gaps.length ? gaps : undefined },
      ]
      setVersions(next)
      setActiveIdx(next.length - 1)
      setPhase('done')

      const fullText: string =
        typeof data.fullText === 'string' ? data.fullText : formatSolutionFullText(result)
      patchWork(id, {
        title: result.title,
        content: fullText,
        solution: result,
        solutionVersions: next,
      })
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      // 补强失败不隐藏已有结果，回结果态并在操作区提示
      setStrengthenError(e instanceof Error ? e.message : '网络异常，请重试')
      setPhase('done')
    } finally {
      clearInterval(stepTimer)
    }
  }

  // ── 云端回源：登录用户跨设备恢复解决方案及版本历史 ──
  // 触发条件：localStorage 和 sessionStorage 均未命中（换设备 / 清缓存后回访）
  // 查询 generation_history 主行 + ::vN 版本行，重建版本数组，回写 localStorage 免下次再查
  async function fetchFromCloud(): Promise<boolean> {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session?.access_token) return false // 未登录，不走云端

      // id 前缀匹配：主行（id 本身）+ 版本行（id::v2, id::v3…）
      // UUID 无碰撞风险，% 是 SQL LIKE 通配符
      const { data: rows, error } = await supabase
        .from('generation_history')
        .select('id, topic, identity_label, style, category, sample_text, blueprint, created_at')
        .like('id', `${id}%`)
        .order('created_at', { ascending: true })

      if (error || !rows || rows.length === 0) return false

      // 按版本号排序：主行（无 ::v 后缀）= V1，有 ::vN 的按 N 排
      const getVersion = (rowId: string): number => {
        const m = /::v(\d+)$/.exec(rowId)
        return m ? parseInt(m[1], 10) : 1
      }
      const sorted = [...rows].sort((a, b) => getVersion(a.id) - getVersion(b.id))

      // 重建版本
      const vers: SolutionVersion[] = []
      let restoredProblem: ProblemUnderstanding | null = null
      let restoredTopic = ''
      let latestSampleText = ''

      for (const row of sorted) {
        const bp = row.blueprint as
          | {
              problem_understanding?: unknown
              solution_result?: unknown
              review?: { note?: unknown; gaps?: unknown[] } | null
            }
          | null

        const result = normalizeSolution(bp?.solution_result)
        if (!result) continue // 旧行无 solution_result（API 升级前数据），跳过

        if (!restoredProblem) {
          restoredProblem = bp?.problem_understanding
            ? normalizeProblem(bp.problem_understanding)
            : null
          restoredTopic = row.topic || row.identity_label || ''
        }
        latestSampleText = row.sample_text || ''

        const review = bp?.review
        const note = typeof review?.note === 'string' && review.note.trim()
          ? review.note.trim().slice(0, 200)
          : undefined
        const gaps = Array.isArray(review?.gaps)
          ? review!.gaps
              .filter((g): g is string => typeof g === 'string' && !!g.trim())
              .slice(0, 4)
              .map((g) => g.slice(0, 200))
          : []

        vers.push({
          result,
          createdAt: row.created_at,
          note,
          gaps: gaps.length ? gaps : undefined,
        })
      }

      if (vers.length === 0) return false

      // 回写 localStorage（免下次再查云端）
      const latest = vers[vers.length - 1].result
      saveWork({
        id,
        title: latest.title,
        content: latestSampleText || formatSolutionFullText(latest),
        category: restoredProblem?.problem_type || '',
        created_at: vers[0].createdAt,
        identityLabel: restoredProblem?.recommended_role,
        topic: restoredTopic,
        solution: latest,
        solutionVersions: vers,
        blueprint: restoredProblem
          ? { problem_understanding: restoredProblem } as unknown as CreativeBlueprint
          : undefined,
      })

      setVersions(vers)
      setActiveIdx(vers.length - 1)
      setProblem(restoredProblem)
      setTopic(restoredTopic)
      solvePayloadRef.current = restoredProblem
        ? { topic: restoredTopic, problem: restoredProblem }
        : null
      setSolveAttempted(true)
      setPhase('done')
      return true
    } catch {
      return false
    }
  }

  // ── 初始化：恢复优先级 ① localStorage → ② sessionStorage → ③ 云端 → ④ 空态 ──
  useEffect(() => {
    const init = async () => {
      const saved = getWork(id)
      if (saved?.solution && saved.solution.sections.length > 0) {
        // 版本恢复：优先 solutionVersions；老数据只有单版本 solution 时包装为 V1
        const vers: SolutionVersion[] =
          saved.solutionVersions && saved.solutionVersions.length > 0
            ? saved.solutionVersions
            : [{ result: saved.solution, createdAt: saved.created_at }]
        setVersions(vers)
        setActiveIdx(vers.length - 1)
        const bp = saved.blueprint as
          | { problem_understanding?: unknown }
          | undefined
        const pu = bp?.problem_understanding
          ? normalizeProblem(bp.problem_understanding)
          : null
        setProblem(pu)
        setTopic(saved.topic || saved.title)
        setPhase('done')
        return
      }

      let payload: SolvePayload | null = null
      try {
        const raw = sessionStorage.getItem(`pending_solution_${id}`)
        if (raw) {
          const parsed = JSON.parse(raw) as { topic?: unknown; problem?: unknown }
          const problemParsed = normalizeProblem(parsed.problem)
          if (typeof parsed.topic === 'string' && parsed.topic && problemParsed) {
            payload = { topic: parsed.topic, problem: problemParsed }
          }
        }
      } catch { /* ignore */ }

      if (payload) {
        void solve(payload)
      } else {
        // ③ 云端回源：登录用户跨设备恢复（localStorage+sessionStorage 均未命中）
        const restored = await fetchFromCloud()
        if (!restored) {
          setPhase('missing')
        }
      }
    }
    void init()
    return () => abortRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function copyFull() {
    if (!solution) return
    try {
      await navigator.clipboard.writeText(formatSolutionFullText(solution))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }

  const progressSteps = mode === 'strengthen' ? STRENGTHEN_STEPS : SOLVING_STEPS

  return (
    <div className="inner-page gen-stage" data-mode="inspiration">
      <div className="inner-container">
        <div className="inner-header">
          <div className="text-center">
            <Link href="/generate" className="inner-back">← 返回灵感场</Link>
            <span className="gen-eyebrow">问题求解</span>
            <h1 className="inner-header-title line-clamp-2">
              {phase === 'done' && solution ? solution.title : '解决方案'}
            </h1>
            {phase === 'done' && problem && (
              <p className="inner-header-sub">
                {problem.problem_type} · 为你量身定制
                {versions.length > 1 && ` · 当前 V${activeIdx + 1}`}
              </p>
            )}
          </div>
        </div>

        {/* 加载中：读取既有结果或等待跳转 */}
        {phase === 'loading' && (
          <div className="gen-status glass anim-rise">
            <div className="mx-auto w-12 h-12 rounded-full border-2 border-indigo-500/30 border-t-indigo-400 animate-spin" />
          </div>
        )}

        {/* 生成中：分阶段进度（首解/补强共用，按 mode 切换文案） */}
        {phase === 'generating' && (
          <div className="gen-status glass anim-rise">
            <div className="mx-auto w-12 h-12 rounded-full border-2 border-indigo-500/30 border-t-indigo-400 animate-spin" />
            <h2 className="text-base font-medium text-white mt-6">
              {mode === 'strengthen' ? '正在补强你的解决方案' : '正在生成你的专属解决方案'}
            </h2>
            <ul className="mt-7 space-y-3 text-left max-w-sm mx-auto">
              {progressSteps.map((label, i) => {
                const state = i < step ? 'done' : i === step ? 'active' : 'pending'
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
                    <span className={`transition-colors duration-300 ${state === 'pending' ? 'text-zinc-600' : 'text-zinc-300'}`}>
                      {label}
                      {state === 'active' && <span className="animate-pulse">…</span>}
                    </span>
                  </li>
                )
              })}
            </ul>
            <p className="text-[11px] text-zinc-600 mt-8">
              {mode === 'strengthen'
                ? '补强需要重新审视并撰写方案，通常需要 40-90 秒'
                : '完整方案需要撰写多个章节，通常需要 30-60 秒'}
            </p>
          </div>
        )}

        {/* 空态 / 错误 */}
        {phase === 'missing' && (
          <div className="gen-status glass anim-rise text-center">
            <span className="text-3xl">🧭</span>
            <p className="text-sm text-zinc-300 mt-4">
              {error || '没有找到这个问题对应的分析数据'}
            </p>
            {error && solveAttempted && (
              <button
                type="button"
                onClick={() => void solve(solvePayloadRef.current!)}
                className="mt-5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition"
              >重试</button>
            )}
            <div className="mt-5">
              <Link href="/generate" className="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-800 hover:border-zinc-600 px-4 py-2 rounded-lg transition">
                去灵感场重新提出问题
              </Link>
            </div>
          </div>
        )}

        {/* 结果态 */}
        {phase === 'done' && solution && (
          <div className="space-y-5 anim-rise">
            {/* 版本切换（存在迭代历史时出现） */}
            {versions.length > 1 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-zinc-500">版本</span>
                {versions.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setActiveIdx(i)}
                    className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                      i === activeIdx
                        ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200'
                        : 'border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'
                    }`}
                  >
                    V{i + 1}{i === versions.length - 1 ? ' · 最新' : ''}
                  </button>
                ))}
              </div>
            )}

            {/* 历史版本只读提示 */}
            {!isLatest && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3">
                <p className="text-xs text-amber-200/90">正在查看历史版本 V{activeIdx + 1}（只读）</p>
                <button
                  type="button"
                  onClick={() => setActiveIdx(versions.length - 1)}
                  className="shrink-0 text-xs text-amber-200 hover:text-white transition"
                >回到最新版 →</button>
              </div>
            )}

            {/* 摘要 */}
            {solution.summary && (
              <div className="flex gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-5 py-4">
                <span className="text-base shrink-0">🎯</span>
                <p className="text-sm text-indigo-100/90 leading-relaxed">{solution.summary}</p>
              </div>
            )}

            {/* 补强说明（属于当前查看的版本，V1 无） */}
            {versions[activeIdx]?.note && (
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-5">
                <p className="text-[11px] font-medium text-emerald-300/80 tracking-wide uppercase">
                  补强说明 · V{activeIdx + 1}
                </p>
                <p className="mt-2 text-sm text-emerald-100/90 leading-relaxed">{versions[activeIdx].note}</p>
                {versions[activeIdx]?.gaps && versions[activeIdx].gaps!.length > 0 && (
                  <>
                    <p className="mt-3 text-[11px] text-zinc-500">上一版的不足</p>
                    <ul className="mt-1.5 space-y-1">
                      {versions[activeIdx].gaps!.map((g, i) => (
                        <li key={i} className="flex gap-2 text-sm text-zinc-300 leading-relaxed">
                          <span className="text-amber-400/80 shrink-0">·</span>
                          <span>{g}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}

            {/* 问题理解回显（折叠） */}
            {problem && (
              <details className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-4">
                <summary className="cursor-pointer text-[11px] font-medium text-zinc-500 tracking-wide uppercase select-none">
                  问题理解
                  <span className="ml-2 normal-case tracking-normal text-zinc-600">本次方案依据</span>
                </summary>
                <pre className="mt-3 whitespace-pre-wrap break-words text-xs text-zinc-400 leading-relaxed font-sans">
                  {formatProblemForPrompt(problem)}
                </pre>
              </details>
            )}

            {/* 方案章节 */}
            {solution.sections.map((sec, i) => (
              <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
                <div className="flex items-center gap-2.5">
                  <span className="shrink-0 w-6 h-6 rounded-full bg-indigo-500/15 text-indigo-300 text-xs flex items-center justify-center">
                    {i + 1}
                  </span>
                  <h2 className="text-sm font-semibold text-white leading-snug">{sec.heading}</h2>
                </div>
                <div className="mt-3 space-y-2.5">
                  {sec.content.split('\n').filter((p) => p.trim()).map((p, j) => (
                    <p key={j} className="text-sm text-zinc-300 leading-relaxed">{p}</p>
                  ))}
                </div>
              </div>
            ))}

            {/* 下一步行动 */}
            {solution.next_steps.length > 0 && (
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-5">
                <p className="text-[11px] font-medium text-emerald-300/80 tracking-wide uppercase">下一步行动</p>
                <ol className="mt-3 space-y-2">
                  {solution.next_steps.map((s, i) => (
                    <li key={i} className="flex gap-2.5 text-sm text-zinc-300 leading-relaxed">
                      <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-300 text-xs flex items-center justify-center mt-0.5">
                        {i + 1}
                      </span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/* 成功自检 */}
            {solution.success_check && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
                <p className="text-[11px] font-medium text-zinc-500 tracking-wide uppercase">成功自检</p>
                <p className="mt-2 text-sm text-zinc-300 leading-relaxed">{solution.success_check}</p>
              </div>
            )}

            {/* 操作区：仅最新版可迭代/重新生成 */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
              <button
                type="button"
                onClick={copyFull}
                className="flex-1 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 py-3.5 rounded-xl font-semibold text-base text-white transition shadow-lg shadow-indigo-900/30"
              >
                {copied ? '✓ 已复制全文' : '复制全文'}
              </button>
            </div>

            {isLatest && (
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                {canIterate && (
                  <button
                    type="button"
                    onClick={() => void strengthen()}
                    className="flex-1 text-sm font-medium text-indigo-300 border border-indigo-500/40 hover:bg-indigo-500/10 px-4 py-3 rounded-xl transition"
                  >⚡ 生成补强版（V{versions.length + 1}）</button>
                )}
                {(topic && problem) && (
                  <button
                    type="button"
                    onClick={() => void solve({ topic, problem: problem! })}
                    className="text-sm text-zinc-300 border border-zinc-800 hover:border-zinc-600 px-4 py-3 rounded-xl transition"
                  >🔄 重新生成</button>
                )}
                <Link
                  href="/generate"
                  className="text-sm text-zinc-500 hover:text-zinc-300 transition text-center"
                >提出新问题</Link>
              </div>
            )}

            {strengthenError && (
              <p className="text-xs text-red-400/90 text-center">
                {strengthenError}（你的当前版本未受影响）
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
