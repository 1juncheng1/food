'use client'

// ============================================================
// WorkAgentChat（AI 共创对话）—— Work Agent 前端入口
//
// 替换原 WorkFeedbackPanel 的"输入框 + 一次性分析卡"，改为真正的多轮对话：
//
//   用户说想法 → AI 列出候选含义（点选）→ AI 列出修改方案（点选）
//   → AI 给出段落补丁（对照 + 接受/继续/拒绝）→ 生成新版本
//
// 与旧面板的本质差别不是 UI，是控制权：
//   旧版把"AI 的理解"当作结论直接执行；这里每一步都要用户点选才推进，
//   AI 无权跳过任何一个阶段直接改文章。
//
// 为什么每条 assistant 消息的 payload 都要过一遍 normalize：
//   消息表是 jsonb，任何历史记录都可能是旧版结构或被并发写成的意外形状，
//   前端按约定直接取字段会崩渲染；normalize 同时兼任"无效则隐藏该交互卡"的守卫。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FeedbackAnalysis } from '@/lib/creative/workAgent'
import type { AlignmentReport } from '@/lib/creative/feedbackAlignment'
import {
  normalizeAdvisory,
  normalizeIntentClarification,
  normalizePatchPreview,
  normalizeRevisionPlan,
  normalizeRevisionProposal,
  type AgentAdvisory,
  type IntentClarification,
  type RevisionPlan,
  type RevisionProposal,
  type WorkAgentMessage,
} from '@/lib/creative/workAgent'
import type { ModificationPatch } from '@/lib/creative/patchEngine'
import { NEXT_ACTION_META } from '@/lib/creative/diagnosisMeta'

interface WorkAgentChatProps {
  /** 当前作品正文（补丁链路的基底，后端以库内版本为准，这里仅用于展示回退） */
  currentContent: string
  topic?: string
  /** 当前版本行 id（generation_history.id） */
  generationId?: string
  /** 当前版本的 AI 诊断（旧链路用，本组件不直接消费） */
  diagnosis?: unknown
  isLoggedIn: boolean
  projectId?: string
  finalized?: boolean
  improvingDirection?: string | null
  /** 快捷方向：rewrite 策略降级时用它走全文重写链路 */
  onQuickDirection?: (direction: string, instruction?: string) => void
  /** 旧链路兼容回调（本组件在重写降级时不走这里） */
  onFeedbackConfirmed?: (analysis: FeedbackAnalysis, freeText: string) => void
  /**
   * 补丁决策（extra 携带本次共创的会话与方案，用于落版溯源）。
   * 返回落库后的新版本 id：本组件要拿它做方向验收——
   * 改出来的新版本到底是不是用户想要的那个方向。
   */
  onPatchDecision?: (
    accepted: boolean,
    patches: ModificationPatch[],
    summary: string,
    analysis: FeedbackAnalysis,
    freeText: string,
    extra?: { sessionId?: string | null; plan?: RevisionPlan | null }
  ) => Promise<string | void>
  /** 父组件（全文重写链路）落盘后的方向验收结果；与组件内部验收共用同一张卡展示 */
  alignmentReport?: AlignmentReport | null
  /** 父组件正在验收中 */
  aligning?: boolean
}

type Stage = 'clarify' | 'propose' | 'patch' | null

/**
 * 单次对话请求的超时上限。
 * 服务端 maxDuration 是 60s，这里给到 90s 留出排队与网络余量。
 * 超过后主动 abort：一个挂死的请求会把界面锁在转圈状态，
 * 而用户除了刷新没有任何退路——刷新又会因内存任务丢失而彻底中断。
 */
const CHAT_TIMEOUT_MS = 90_000

/** 补丁预览消息里的数据结构（服务端 chat 路由阶段 3 写入） */
interface PatchPayload {
  plan: RevisionPlan | null
  patches: ModificationPatch[]
}

function sanitizePatches(raw: unknown): ModificationPatch[] {
  const list = Array.isArray((raw as { patches?: unknown } | null)?.patches)
    ? ((raw as { patches: unknown[] }).patches)
    : []
  return list
    .map((p) => {
      if (typeof p !== 'object' || p === null) return null
      const o = p as Record<string, unknown>
      return {
        segmentIndex: Number(o.segmentIndex ?? o.segment_index) || 0,
        segmentExcerpt: String(o.segmentExcerpt ?? o.segment_excerpt ?? ''),
        originalExcerpt: String(o.originalExcerpt ?? o.original_excerpt ?? ''),
        revisedText: String(o.revisedText ?? o.revised_text ?? ''),
        reason: String(o.reason ?? ''),
      }
    })
    .filter((p): p is ModificationPatch => !!p && !!p.revisedText)
    .slice(0, 5)
}

export function WorkAgentChat({
  topic,
  generationId,
  isLoggedIn,
  projectId,
  finalized = false,
  improvingDirection,
  onQuickDirection,
  onPatchDecision,
  // 全文重写链路的验收由父组件发起（新版本在父组件侧落盘），结果回传到这里展示
  alignmentReport: externalAlignment = null,
  aligning: externalAligning = false,
}: WorkAgentChatProps) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  // 会话 id 的同步镜像：自动推进阶段（降级后立即发起下一步请求）会用同一个 sessionId，
  // 此时 setState 尚未生效，闭包里的 sessionId 还是旧值，必须读 ref 才不会另开会话。
  const sessionIdRef = useRef<string | null>(null)
  const [messages, setMessages] = useState<WorkAgentMessage[]>([])
  const [input, setInput] = useState('')
  const [stage, setStage] = useState<Stage>(null)
  const [error, setError] = useState('')
  const [degradedReason, setDegradedReason] = useState('')
  // 方向验收：新版本到底有没有按用户反馈的方向改（校验不可用时为 null，静默跳过）
  const [alignment, setAlignment] = useState<AlignmentReport | null>(null)
  const [aligning, setAligning] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, stage])

  // ── 恢复会话：刷新或返回页面后对话不该失忆 ──
  useEffect(() => {
    if (!generationId || !isLoggedIn || finalized) return
    let cancelled = false
    ;(async () => {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        const { supabase } = await import('@/lib/supabaseClient')
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (!session?.access_token) return
        headers.Authorization = `Bearer ${session.access_token}`

        const res = await fetch('/api/creative/work-agent/session', {
          method: 'POST',
          headers,
          body: JSON.stringify({ projectId, baseVersionId: generationId }),
        })
        if (!res.ok) return
        const data = (await res.json()) as {
          session?: { id: string; phase: string; status: string }
          messages?: WorkAgentMessage[]
        }
        if (cancelled || !data.session?.id) return
        sessionIdRef.current = data.session.id
        setSessionId(data.session.id)
        const restored = data.messages ?? []
        setMessages(restored)
        // ⚠️ 这里绝不能按最后一条消息的 kind 把 stage 设成 'propose'/'patch'。
        // stage 的语义是「有请求正在飞行」，而「最后一条是方案卡/补丁卡」只表示
        // 「等待用户点选」——并没有任何请求在跑。两者混用会让恢复会话后 busy 恒为 true：
        // 转圈动画永久显示、输入框永久禁用，用户只能刷新，刷新后又回到同一个死循环。
        // 「等待点选」由下方 lastAssistant.kind 自行渲染对应交互卡，不需要 stage 参与。
        setStage(null)
      } catch {
        // 恢复失败不影响新建对话：用户发第一句话时会自动建会话
      }
    })()
    return () => {
      cancelled = true
    }
  }, [generationId, isLoggedIn, projectId, finalized])

  const callChat = useCallback(
    async (payload: Record<string, unknown>) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (isLoggedIn) {
        const { supabase } = await import('@/lib/supabaseClient')
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS)
      try {
        const res = await fetch('/api/creative/work-agent/chat', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            generationId,
            topic,
            sessionId: sessionIdRef.current,
            ...payload,
          }),
          signal: controller.signal,
        })
        const data = (await res.json().catch(() => null)) as
          | {
              ok?: boolean
              error?: string
              sessionId?: string
              phase?: string
              message?: WorkAgentMessage
              intentOptions?: unknown
              patches?: ModificationPatch[]
              summary?: string
              plan?: RevisionPlan
              analysis?: FeedbackAnalysis
              degradedReasons?: string[]
              rewrite?: boolean
              instruction?: string
              skipPlan?: boolean
              skipToPlan?: boolean
            }
          | null
        if (!res.ok || !data) throw new Error(data?.error ?? `请求失败（${res.status}）`)
        return data
      } catch (e) {
        // fetch 没有默认超时：服务端挂起时 Promise 永不 settle，界面会一直转圈。
        // 超时必须转成用户看得懂的失败，而不是让它无限等待。
        if (e instanceof Error && e.name === 'AbortError') {
          throw new Error('AI 响应超时，请重试')
        }
        throw e
      } finally {
        clearTimeout(timer)
      }
    },
    [generationId, isLoggedIn, topic]
  )

  /** 记下会话 id：同步写 ref，保证同一次交互内自动推进阶段时复用同一会话 */
  const applySession = useCallback((id?: string) => {
    if (!id) return
    sessionIdRef.current = id
    setSessionId(id)
  }, [])

  async function handleSend() {
    const text = input.trim()
    if (!text || stage || improvingDirection) return
    setError('')
    setDegradedReason('')
    setStage('clarify')
    setInput('')
    // 乐观渲染：先把用户发言上屏，等不到回应也不至于像卡住
    const optimistic: WorkAgentMessage = {
      id: `tmp-${Date.now()}`,
      sessionId: sessionId ?? '',
      role: 'user',
      kind: 'intent_clarify',
      content: text,
      payload: null,
      selectedIndex: null,
      createdAt: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimistic])
    try {
      const data = await callChat({ action: 'say', message: text })
      applySession(data.sessionId)
      if (data.message) setMessages((prev) => [...prev, data.message!])
      if (data.degradedReasons?.length) setDegradedReason(data.degradedReasons.join('；'))
      // 服务端没能拆出候选（降级）：立刻用用户原话推进到方案阶段。
      // 不推进的话，界面只剩一句"我没能拆成候选"，既没有候选可点、也进不了下一步，
      // 用户只能反复重发同一句话——表现上与"卡死"没有区别。
      if (data.skipToPlan) {
        await runSelect('select_intent', -1)
        return
      }
      setStage(null)
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id))
      setError(e instanceof Error ? e.message : '对话失败，请重试')
      setStage(null)
    }
  }

  /**
   * 阶段推进：选意图 → 出方案 → 出补丁。
   * index = -1 表示"没有候选项，直接用用户原话推进"（服务端降级链路专用）。
   * 与 handleSelect 分开：自动推进不能被"进行中则忽略"的守卫挡掉。
   */
  async function runSelect(action: 'select_intent' | 'select_plan', index: number) {
    setError('')
    setDegradedReason('')
    setStage(action === 'select_intent' ? 'propose' : 'patch')
    try {
      const data = await callChat({ action, selectedIndex: index })
      applySession(data.sessionId)
      if (data.message) setMessages((prev) => [...prev, data.message!])
      if (data.degradedReasons?.length) setDegradedReason(data.degradedReasons.join('；'))

      // rewrite 策略 / 补丁降级：这个改动本质上要重写全文，交给已有的迭代链路，
      // 并且必须当作一次明确的重写展示给用户，而不是悄悄换一种执行方式。
      // 交出去之前必须先把 stage 归零：stage 是 busy 的判定源，这里不清的话，
      // 重写结束后 improvingDirection 归零而 stage 仍是 'patch'，界面会一直转圈。
      if (data.rewrite) {
        setStage(null)
        onQuickDirection?.('custom', data.instruction ?? '按我们讨论的方向优化这篇作品')
        return
      }
      // 方案生成降级：直接拿用户原话生成补丁，别把用户晾在无可选项的界面上
      if (action === 'select_intent' && data.skipPlan) {
        await runSelect('select_plan', -1)
        return
      }
      setStage(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试')
      setStage(null)
    }
  }

  /** 用户点选入口：有请求在飞行中时忽略，避免重复提交 */
  function handleSelect(action: 'select_intent' | 'select_plan', index: number) {
    if (stage || improvingDirection) return
    void runSelect(action, index)
  }

  /**
   * 方向验收：落库成功后核对新版本是否真的落实了用户的反馈方向。
   *
   * 这是整条共创链路的闭环——在此之前，"改完了"就等于"改好了"，
   * 用户只能自己通读全文去发现 AI 根本没按他说的改，或者顺手改掉了要求保留的部分。
   *
   * 校验失败一律静默：新版本已经落库，验收只是把结论呈现给用户，
   * 绝不能反过来卡住主流程（所以这里不抛错、不 setError）。
   */
  async function verifyAlignment(
    versionId: string,
    plan: RevisionPlan | null,
    freeText: string
  ): Promise<void> {
    if (!versionId || !freeText) return
    setAligning(true)
    setAlignment(null)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (isLoggedIn) {
        const { supabase } = await import('@/lib/supabaseClient')
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
      }
      const res = await fetch('/api/creative/alignment', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          generationId: versionId,
          // 本次补丁的融合基底就是打开共创时的那一版
          baseVersionId: generationId,
          freeText,
          intentLabel: plan?.title,
          targets: plan
            ? [plan.title, ...(plan.modificationArea ?? [])].filter(Boolean).slice(0, 6)
            : [],
          preserveItems: (plan?.preserveItems ?? []).slice(0, 4),
        }),
      })
      const data = (await res.json().catch(() => null)) as { report?: AlignmentReport | null } | null
      setAlignment(data?.report ?? null)
    } catch {
      // 验收失败不打扰用户：新版本本身已经落库成功
    } finally {
      setAligning(false)
    }
  }

  /** 接受/拒绝补丁 → 父组件调 decide 服务端融合落库 */
  async function handleDecide(accepted: boolean, patchMsg: PatchPayload, summary: string) {
    if (!onPatchDecision) {
      setError('当前页面未接入落库回调，无法保存新版本')
      return
    }
    setStage('patch')
    setError('')
    try {
      const userSay =
        [...messages].reverse().find((m) => m.role === 'user' && m.kind === 'intent_clarify')
          ?.content ?? ''
      const newVersionId = await onPatchDecision(
        accepted,
        patchMsg.patches,
        summary,
        {
          intentType: 'custom',
          modificationTargets: patchMsg.plan ? [patchMsg.plan.title] : ['局部修改'],
          optimizationBlueprint: patchMsg.plan?.description ?? '',
          userIntentSummary: userSay.slice(0, 200) || 'Work Agent 局部修改',
          impactScope: patchMsg.plan?.modificationArea ?? [],
          preserveItems: patchMsg.plan?.preserveItems ?? [],
        },
        userSay,
        { sessionId, plan: patchMsg.plan }
      )
      if (!accepted) {
        // 拒绝后会话在后端回退到 propose，这里同步让界面可以重新选方案
        setMessages((prev) => prev.slice(0, -1))
        return
      }
      // 落库成功 → 验收这次改动是不是真的落在用户说的方向上
      await verifyAlignment(
        typeof newVersionId === 'string' ? newVersionId : '',
        patchMsg.plan,
        userSay
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : '落库失败，请重试')
    } finally {
      setStage(null)
    }
  }

  if (!projectId || finalized) return null

  // ── 最新一轮可交互的 assistant 消息 ──
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const clarification = lastAssistant?.kind === 'intent_clarify'
    ? normalizeIntentClarification(lastAssistant.payload)
    : null
  const proposal = lastAssistant?.kind === 'proposal'
    ? normalizeRevisionProposal(lastAssistant.payload)
    : null
  const patchPayload =
    lastAssistant?.kind === 'patch_preview'
      ? ({
          plan: normalizeRevisionPlan((lastAssistant.payload as PatchPayload | null)?.plan),
          patches: sanitizePatches(lastAssistant.payload),
        } as PatchPayload)
      : null
  const preview = lastAssistant?.kind === 'patch_preview'
    ? normalizePatchPreview((lastAssistant.payload as { preview?: unknown } | null)?.preview)
    : null
  // 守门提示：AI 认为这个改法会伤害作品时的提醒（只提示不阻拦，用户仍可继续）
  const advisory = lastAssistant
    ? normalizeAdvisory((lastAssistant.payload as { advisory?: unknown } | null)?.advisory)
    : null

  const busy = stage !== null || !!improvingDirection
  // 验收结果：组件内部（补丁链路）优先，其次用父组件回传的（全文重写链路）
  const shownAlignment = alignment ?? externalAlignment

  return (
    <div className="vs-cocreate">
      {/* 标题由宿主页面给（「和 AI 一起改这一版」），这里不重复贴标签 */}
      {messages.length > 0 && !busy && (
        <div className="vs-cocreate-head vs-cocreate-head-end">
          <button
            onClick={() => {
              setMessages([])
              sessionIdRef.current = null
              setSessionId(null)
              setStage(null)
              setError('')
              setDegradedReason('')
            }}
            className="vs-link text-[13px]"
          >
            新开一轮
          </button>
        </div>
      )}

      {/* ── 决策记录：一轮一轮写下来，不是对话气泡 ── */}
      {messages.length > 0 && (
        <div ref={scrollRef} className="vs-cocreate-log dark-scroll">
          {messages.map((m, i) => (
            <LogRow key={m.id} index={i} message={m} />
          ))}
          {stage && (
            <div className="vs-cocreate-run">
              <span className="vs-ai-dots" aria-hidden="true">
                <i className="vs-ai-dot" />
                <i className="vs-ai-dot" />
                <i className="vs-ai-dot" />
              </span>
              <span>
                {stage === 'clarify'
                  ? '理解你的反馈'
                  : stage === 'propose'
                    ? '生成修改方案'
                    : '生成改动预览'}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── 方向验收：这次改动有没有落到用户说的方向上 ── */}
      {(aligning || externalAligning || shownAlignment) && (
        <div className="vs-cocreate-block">
          <p className="vs-mark">方向验收</p>
          {aligning || externalAligning ? (
            <div className="vs-cocreate-run">
              <span className="vs-ai-dots" aria-hidden="true">
                <i className="vs-ai-dot" />
                <i className="vs-ai-dot" />
                <i className="vs-ai-dot" />
              </span>
              <span>核对这次改动是否落在你说的方向上</span>
            </div>
          ) : shownAlignment ? (
            <AlignmentCard report={shownAlignment} />
          ) : null}
        </div>
      )}

      {/* ── 修改守门提示 ──
          不是拦路：结论交给用户，他看完坚持要改，AI 照改。
          这里必须连替代方案一起显示——只说"不好"等于把问题丢回给用户。 */}
      {advisory && <AdvisoryCard advisory={advisory} />}

      {/* ── 01 确认方向 ── */}
      {clarification && !busy && (
        <div className="vs-cocreate-block">
          <p className="vs-mark vs-step-label">
            <span className="vs-num vs-num-dim">01</span>
            确认方向
          </p>
          <div className="vs-choice">
            {clarification.options.map((opt, i) => (
              <button
                key={opt.id}
                onClick={() => handleSelect('select_intent', i)}
                className="vs-choice-item"
              >
                <span className="vs-num vs-num-dim">{String.fromCharCode(65 + i)}</span>
                <span className="vs-choice-body">
                  <span className="vs-choice-title">{opt.label}</span>
                  <span className="vs-choice-desc">{opt.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── 02 选择改法 ── */}
      {proposal && !busy && (
        <div className="vs-cocreate-block">
          <p className="vs-mark vs-step-label">
            <span className="vs-num vs-num-dim">02</span>
            选择改法
          </p>
          <div className="vs-plan">
            {proposal.plans.map((plan, i) => (
              <button
                key={plan.id}
                onClick={() => handleSelect('select_plan', i)}
                className="vs-plan-item"
              >
                <span className="vs-plan-head">
                  <span className="vs-plan-title">
                    <span className="vs-num vs-num-dim">{String.fromCharCode(65 + i)}</span>
                    {plan.title}
                  </span>
                  <span className="vs-plan-tag">
                    {plan.strategy === 'rewrite' ? '全文重写' : '局部修改'}
                  </span>
                </span>
                <span className="vs-note block mt-2 leading-relaxed">{plan.description}</span>
                <span className="vs-plan-meta">
                  <span>
                    <span className="vs-plan-key">影响</span>
                    {plan.expectedImpact}
                  </span>
                  {plan.modificationArea.length > 0 && (
                    <span>
                      <span className="vs-plan-key">范围</span>
                      {plan.modificationArea.join('、')}
                    </span>
                  )}
                  <span>
                    <span className="vs-plan-key">保持</span>
                    {plan.preserveItems.join('、')}
                  </span>
                </span>
                {plan.risk && (
                  <span className="vs-note vs-note-warn block mt-2">注意：{plan.risk}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── 03 查看改动 ── */}
      {patchPayload && patchPayload.patches.length > 0 && !busy && (
        <div className="vs-cocreate-block">
          <p className="vs-mark vs-step-label">
            <span className="vs-num vs-num-dim">03</span>
            查看改动
          </p>
          <p className="vs-note">共 {patchPayload.patches.length} 处局部修改</p>
          {preview?.preserveItems && preview.preserveItems.length > 0 && (
            <p className="vs-note">保持不变：{preview.preserveItems.join('、')}</p>
          )}
          <div className="vs-diff">
            {patchPayload.patches.map((p, i) => (
              <details key={i} className="vs-diff-item">
                <summary>
                  <span className="vs-num vs-num-dim">第 {p.segmentIndex} 段</span>
                  <span>{p.reason || '优化表达'}</span>
                </summary>
                <div className="vs-diff-body">
                  <p className="vs-diff-before">{p.originalExcerpt.slice(0, 300)}</p>
                  <p className="vs-diff-after">{p.revisedText.slice(0, 600)}</p>
                </div>
              </details>
            ))}
          </div>
          <div className="vs-cocreate-actions">
            <button
              onClick={() => handleDecide(true, patchPayload, lastAssistant?.content ?? '')}
              className="vs-btn vs-btn-primary vs-btn-sm"
            >
              接受，生成新版本
            </button>
            <button
              onClick={() => handleDecide(false, patchPayload, lastAssistant?.content ?? '')}
              className="vs-btn vs-btn-ghost vs-btn-sm"
            >
              都不满意
            </button>
            <button
              onClick={() => setMessages((prev) => prev.slice(0, -1))}
              className="vs-btn vs-btn-ghost vs-btn-sm"
            >
              换个方案
            </button>
          </div>
        </div>
      )}

      {/* ── 提示区 ── */}
      {degradedReason && (
        <p className="vs-note vs-note-warn">
          部分上下文未能加载：{degradedReason}（不影响共创，AI 会少一些你的素材与画像参考）
        </p>
      )}
      {error && <p className="vs-error">{error}</p>}

      {/* ── 输入：编辑线，不是聊天输入框 ── */}
      <div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleSend()
          }}
          placeholder="说说你的想法，例如：这篇太平了，没什么记忆点…"
          rows={2}
          disabled={busy}
          className="vs-input vs-input-area dark-scroll"
        />
        <div className="vs-cocreate-send">
          <button
            onClick={handleSend}
            disabled={!input.trim() || busy}
            className="vs-btn vs-btn-primary vs-btn-sm"
          >
            {stage === 'clarify' ? '进行中' : '发送'}
          </button>
          <span className="vs-note">⌘/Ctrl + Enter 快速发送</span>
        </div>
      </div>

      {/* ── 快捷方向（6 类）：对话未开始时才展示 ──
          不是装饰——有些用户已经很清楚要什么，不该被强制走完三轮对话。
          但一旦开始对话就隐藏，避免"直接改全文"的旧习惯把共创流程架空。 */}
      {messages.length === 0 && !busy && (
        <div className="vs-cocreate-alt">
          <p className="vs-mark">或者直接选择优化方向</p>
          <div className="vs-chip-row">
            {NEXT_ACTION_META.map((m) => (
              <button
                key={m.key}
                onClick={() =>
                  onQuickDirection?.(m.key, m.key === 'custom' ? input.trim() || undefined : undefined)
                }
                title={m.blurb}
                className="vs-chip"
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── 消息气泡 ──────────────────────────────────────────────

/**
 * 方向验收结果卡。
 * 把"这次改动到底改没改到位"明确摆出来：逐条列出修改点是否落实、
 * 以及要求保持的内容有没有被顺手改掉——这些本来只能靠用户自己通读全文去发现。
 */
function AlignmentCard({ report }: { report: AlignmentReport }) {
  // 落实是中性白，只有"部分/不符"才带颜色：结论靠文字说，不靠色块喊
  const verdict =
    report.verdict === 'aligned'
      ? { label: '已落实', key: 'aligned' }
      : report.verdict === 'partial'
        ? { label: '部分落实', key: 'partial' }
        : { label: '与方向不符', key: 'off' }
  const broken = report.preserved.filter((p) => !p.intact)

  return (
    <div>
      <span className="vs-verdict" data-verdict={verdict.key}>
        {verdict.label} · {report.score} 分
      </span>
      <p className="vs-note mt-2.5">{report.summary}</p>
      {report.addressed.length > 0 && (
        <ul className="vs-check-list mt-3">
          {report.addressed.map((a, i) => (
            <li key={i}>
              <span className="vs-check-mark" data-hit={a.hit}>
                {a.hit ? '✓' : '✗'}
              </span>
              <span>
                {a.target}
                {a.evidence ? <span className="vs-plan-key"> — {a.evidence}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {broken.length > 0 && (
        <p className="vs-note vs-note-warn mt-3">
          注意：要求保持的「{broken.map((p) => p.item).join('、')}」被改动了
        </p>
      )}
    </div>
  )
}

/**
 * 修改守门提示卡。
 *
 * 语气上是"我不同意这个改法"，不是"我不干"——
 * 用户看完坚持，下面的候选/方案按钮照常可点，AI 不会替他放弃。
 */
function AdvisoryCard({ advisory }: { advisory: AgentAdvisory }) {
  return (
    <div className="vs-cocreate-block">
      <p className="vs-mark vs-mark-row">一个不同意见</p>
      <p className="vs-body">{advisory.concern}</p>
      <p className="vs-note mt-2.5">{advisory.why}</p>
      <p className="vs-note mt-2">更建议：{advisory.better}</p>
      <p className="vs-note mt-2">这只是判断。你要坚持，就按你的方向改。</p>
    </div>
  )
}

function LogRow({ index, message }: { index: number; message: WorkAgentMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className="vs-log-row" data-role={message.role}>
      <span className="vs-num vs-num-dim">{String(index + 1).padStart(2, '0')}</span>
      <div className="vs-log-body">
        <p className="vs-log-label">{isUser ? '你' : 'AI'}</p>
        <p className="vs-log-text">{message.content}</p>
      </div>
    </div>
  )
}
