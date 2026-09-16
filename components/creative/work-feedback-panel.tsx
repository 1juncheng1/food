'use client'

// ============================================================
// WorkFeedbackPanel（作品反馈面板）—— Work Agent 阶段 3
//
// 作品结果页的"继续优化区域"。整合三种反馈路径：
//   1. 自由文本反馈（用户输入"不够震撼"）→ Feedback Analyzer 分析 → 用户确认 → 触发 V2
//   2. 快捷优化按钮（6 类预设方向）→ 直接触发定向迭代
//   3. 反馈历史展开（查看该版本历史反馈）
//
// 设计原则：
//   - 不要做聊天机器人：每次反馈都是"分析→确认→生成新版本"的明确动作
//   - 自由反馈必须先展示 AI 理解，让用户确认后再生成（避免误解触发无效迭代）
//   - 快捷方向直接触发（无需确认），与现有 handleImprove 行为一致
// ============================================================

import { useState } from 'react'
import {
  NEXT_ACTION_META,
  type NextActionKey,
} from '@/lib/creative/diagnosis'
import type { FeedbackAnalysis } from '@/lib/creative/workAgent'
import type { ModificationPatch } from '@/lib/creative/patchEngine'

interface WorkFeedbackPanelProps {
  /** 当前作品正文（送 Feedback Analyzer 分析用） */
  currentContent: string
  /** 创作主题 */
  topic?: string
  /** 当前版本行 id（落库关联用） */
  generationId?: string
  /** 当前版本的 AI 诊断报告（辅助分析） */
  diagnosis?: unknown
  /** 用户登录态（决定是否落库） */
  isLoggedIn: boolean
  /** 项目作品 ID（决定能否触发迭代；非项目作品 = undefined 不显示快捷方向） */
  projectId?: string
  /** 项目是否已定稿（定稿后禁用所有反馈入口） */
  finalized?: boolean
  /** 正在迭代的方向（loading 态） */
  improvingDirection?: NextActionKey | null
  /** 快捷方向点击回调（沿用现有 handleImprove 签名） */
  onQuickDirection?: (direction: NextActionKey, instruction?: string) => void
  /** 自由反馈确认后的回调（触发新版本生成） */
  onFeedbackConfirmed?: (analysis: FeedbackAnalysis, freeText: string) => void
  /**
   * AI 协作修改（P4）：分析确认后先生成段落级补丁建议，用户对建议三选一。
   * 不传此回调 = 走旧的"确认即全文重写"链路（向后兼容）。
   */
  onPatchDecision?: (
    accepted: boolean,
    patches: ModificationPatch[],
    summary: string,
    analysis: FeedbackAnalysis,
    freeText: string
  ) => Promise<void>
}

// ── 状态机 ────────────────────────────────────────────────
//
// idle → analyzing（AI 分析中）→ analyzed（展示 AI 理解，等用户确认）
//                                            ↓ 用户确认
//                                       generating（触发迭代）
//                                            ↓ 外部 improvingDirection 清空
//                                          idle
//
// idle → analyzing → error（AI 分析失败，降级为 custom 方向直触发）
//                                            ↓
//                                          idle

type FeedbackState = 'idle' | 'analyzing' | 'analyzed' | 'generating' | 'error'

export function WorkFeedbackPanel({
  currentContent,
  topic,
  generationId,
  diagnosis,
  isLoggedIn,
  projectId,
  finalized = false,
  improvingDirection,
  onQuickDirection,
  onFeedbackConfirmed,
  onPatchDecision,
}: WorkFeedbackPanelProps) {
  const [state, setState] = useState<FeedbackState>('idle')
  const [freeText, setFreeText] = useState('')
  const [analysis, setAnalysis] = useState<FeedbackAnalysis | null>(null)
  const [degraded, setDegraded] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  // ── P4 补丁建议状态 ──
  const [patches, setPatches] = useState<ModificationPatch[] | null>(null)
  const [patchSummary, setPatchSummary] = useState('')
  const [patchLoading, setPatchLoading] = useState(false)
  const [patchError, setPatchError] = useState('')
  const [deciding, setDeciding] = useState(false)
  // 继续调整循环：被拒补丁（负例）+ 上一轮补丁（上下文）
  const [rejectedPatches, setRejectedPatches] = useState<ModificationPatch[]>([])
  const [previousPatches, setPreviousPatches] = useState<ModificationPatch[]>([])

  const disabled =
    finalized || !projectId || !!improvingDirection || state === 'analyzing'

  async function handleAnalyze() {
    if (!freeText.trim() || state === 'analyzing') return
    setState('analyzing')
    setErrorMsg('')
    setAnalysis(null)
    setDegraded(false)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      // session 存 localStorage，需显式传 token
      if (isLoggedIn) {
        const { supabase } = await import('@/lib/supabaseClient')
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.access_token) {
          headers.Authorization = `Bearer ${session.access_token}`
        }
      }

      const res = await fetch('/api/creative/analyze-feedback', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          freeText: freeText.trim(),
          currentContent,
          topic,
          generationId,
          diagnosis,
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error || `分析失败（${res.status}）`)
      }

      const data = (await res.json()) as {
        analysis: FeedbackAnalysis
        degraded?: boolean
      }
      setAnalysis(data.analysis)
      setDegraded(!!data.degraded)
      setState('analyzed')
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : '网络异常，请重试')
      setState('error')
    }
  }

  async function handleConfirmGenerate() {
    if (!analysis) return
    // 旧链路（未接补丁回调）：确认即全文重写
    if (!onPatchDecision) {
      setState('generating')
      onFeedbackConfirmed?.(analysis, freeText.trim())
      return
    }
    // 新链路（AI 协作修改）：确认理解后先生成段落级补丁建议
    setState('generating')
    setPatchLoading(true)
    setPatchError('')
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const { supabase } = await import('@/lib/supabaseClient')
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        headers.Authorization = `Bearer ${session.access_token}`
      }

      const res = await fetch('/api/creative/patch', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: currentContent,
          freeText: freeText.trim(),
          analysis,
          topic,
          rejectedPatches,
          previousPatches,
        }),
      })
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean
        patches?: ModificationPatch[]
        summary?: string
        degraded?: boolean
        reason?: string
        error?: string
      } | null

      // 降级或失败 → 回退现有全文重写链路（提示可见，不静默）
      if (!res.ok || !data?.ok || !data.patches?.length) {
        if (data?.degraded) {
          setDegraded(true)
          setPatchError(data.reason || '已切换为全文优化模式')
        } else {
          setPatchError(data?.error || '修改建议生成失败，可改为全文优化')
        }
        setState('analyzed') // 回到确认区，用户可重新选择
        return
      }

      setPatches(data.patches)
      setPatchSummary(data.summary || '')
      setState('analyzed')
    } catch (e) {
      setPatchError(e instanceof Error ? e.message : '网络异常，已切换为全文优化模式')
      setState('analyzed')
    } finally {
      setPatchLoading(false)
    }
  }

  /** 补丁决策：接受 / 拒绝（由父组件调 decide 落库） */
  async function handleDecide(accepted: boolean) {
    if (!patches || !analysis || deciding) return
    setDeciding(true)
    setPatchError('')
    try {
      await onPatchDecision?.(accepted, patches, patchSummary, analysis, freeText.trim())
    } catch (e) {
      setPatchError(e instanceof Error ? e.message : '处理失败，请重试')
    } finally {
      setDeciding(false)
    }
  }

  /** 降级直通：跳过补丁，直接走旧"全文重写"链路（handleFeedbackConfirmed） */
  function handleFallbackFullRewrite() {
    if (!analysis) return
    setState('generating')
    onFeedbackConfirmed?.(analysis, freeText.trim())
  }

  /** 继续调整：当前补丁作负例，留在建议视图等用户补充反馈重新生成 */
  function handleContinueTuning() {
    if (!patches) return
    setRejectedPatches(patches)
    setPreviousPatches(patches)
    setPatches(null)
    setPatchSummary('')
    // 回到反馈输入态，freeText 保留，用户追加"哪里还不满意"后重新出补丁
    setState('idle')
  }

  function handleCancelAnalysis() {
    setState('idle')
    setAnalysis(null)
    setDegraded(false)
    setErrorMsg('')
    setPatches(null)
    setPatchSummary('')
    setRejectedPatches([])
    setPreviousPatches([])
    // 保留 freeText，让用户可以编辑后重新提交
  }

  function handleReset() {
    setState('idle')
    setFreeText('')
    setAnalysis(null)
    setDegraded(false)
    setErrorMsg('')
    setPatches(null)
    setPatchSummary('')
    setRejectedPatches([])
    setPreviousPatches([])
  }

  // ── 非项目作品或定稿：不渲染面板 ──
  if (!projectId || finalized) return null

  return (
    <div className="mt-10 pt-8 border-t border-zinc-800/80">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm font-medium text-zinc-300">继续优化这一版</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            告诉 AI 哪里需要改，它会生成下一版（V2/V3…）
          </p>
        </div>
        {(state === 'analyzed' || state === 'error') && (
          <button
            onClick={handleReset}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition"
          >
            收起
          </button>
        )}
      </div>

      {/* ── 自由文本反馈输入 ── */}
      {state === 'idle' || state === 'analyzing' || state === 'error' ? (
        <div>
          <textarea
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="例如：开头不够吸引人 / 想增加案例 / 不够震撼 / 改成更轻松的口吻…"
            rows={3}
            disabled={state === 'analyzing'}
            className="w-full bg-zinc-900/60 border border-zinc-700 rounded-xl px-4 py-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 resize-none dark-scroll disabled:opacity-50"
          />
          <div className="flex items-center gap-3 mt-2">
            <button
              onClick={handleAnalyze}
              disabled={
                !freeText.trim() ||
                state === 'analyzing' ||
                !!improvingDirection
              }
              className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-500 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {state === 'analyzing' ? (
                <>
                  <span className="inline-block h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin align-[-1px] mr-1.5" />
                  AI 理解中…
                </>
              ) : (
                '让 AI 理解我的反馈'
              )}
            </button>
            {state === 'error' && (
              <span className="text-xs text-red-400">{errorMsg}</span>
            )}
          </div>
        </div>
      ) : null}

      {/* ── AI 理解确认区 ── */}
      {(state === 'analyzed' || state === 'generating') && analysis ? (
        <div className="bg-indigo-500/5 border border-indigo-500/25 rounded-xl px-5 py-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[10px] font-medium text-indigo-400 tracking-wide uppercase">
              AI 对你反馈的理解
            </span>
            {degraded && (
              <span className="text-[10px] text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">
                降级模式
              </span>
            )}
          </div>
          <p className="text-sm text-zinc-200 leading-relaxed mb-3">
            <span className="text-zinc-500">理解：</span>
            {analysis.userIntentSummary}
          </p>
          <div className="flex flex-wrap gap-2 mb-3">
            <span className="rounded-full border border-zinc-700 bg-zinc-800/60 px-3 py-1 text-xs text-zinc-300">
              <span className="text-zinc-500 mr-1">方向:</span>
              {NEXT_ACTION_META.find((m) => m.key === analysis.intentType)?.emoji}{' '}
              {NEXT_ACTION_META.find((m) => m.key === analysis.intentType)?.label ??
                analysis.intentType}
            </span>
            {analysis.modificationTargets.map((t, i) => (
              <span
                key={i}
                className="rounded-full border border-zinc-700 bg-zinc-800/60 px-3 py-1 text-xs text-zinc-300"
              >
                {t}
              </span>
            ))}
            {(analysis.impactScope ?? []).map((scope) => (
              <span
                key={`scope-${scope}`}
                className="rounded-full border border-indigo-500/40 bg-indigo-500/10 px-3 py-1 text-xs text-indigo-300"
              >
                <span className="text-indigo-400/70 mr-1">范围:</span>
                {scope}
              </span>
            ))}
          </div>
          {(analysis.preserveItems ?? []).length > 0 && (
            <p className="text-xs text-zinc-400 leading-relaxed mb-3">
              <span className="text-zinc-500">保持不变：</span>
              {analysis.preserveItems!.join('、')}
            </p>
          )}
          <p className="text-xs text-zinc-400 leading-relaxed mb-4">
            <span className="text-zinc-500">优化蓝图：</span>
            {analysis.optimizationBlueprint}
          </p>
          {patchError && (
            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-3">
              {patchError}
              {onFeedbackConfirmed && (
                <button
                  onClick={handleFallbackFullRewrite}
                  disabled={patchLoading}
                  className="ml-2 underline underline-offset-2 hover:text-amber-300 disabled:opacity-50"
                >
                  改用全文优化
                </button>
              )}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={handleConfirmGenerate}
              disabled={state === 'generating' || !!improvingDirection}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {state === 'generating' || patchLoading ? (
                <>
                  <span className="inline-block h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin align-[-1px] mr-1.5" />
                  {patchLoading ? '生成修改建议…' : '生成下一版…'}
                </>
              ) : onPatchDecision ? (
                '✓ 确认理解，生成修改建议'
              ) : (
                '✓ 确认理解，生成下一版'
              )}
            </button>
            <button
              onClick={handleCancelAnalysis}
              disabled={state === 'generating' || !!improvingDirection}
              className="px-4 py-2 rounded-lg text-sm text-zinc-400 border border-zinc-700 hover:border-zinc-500 hover:text-zinc-200 transition disabled:opacity-40"
            >
              重新描述
            </button>
          </div>
        </div>
      ) : null}

      {/* ── AI 修改建议窗口（P4：段落级补丁对照 + 三操作）── */}
      {patches && analysis ? (
        <div className="mt-4 bg-emerald-500/5 border border-emerald-500/25 rounded-xl px-5 py-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <p className="text-[10px] font-medium text-emerald-400 tracking-wide uppercase">
                AI 修改建议（局部修改，不影响其余内容）
              </p>
              {patchSummary && (
                <p className="text-xs text-zinc-400 mt-1">{patchSummary}</p>
              )}
            </div>
            <button
              onClick={handleCancelAnalysis}
              disabled={deciding}
              className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300 transition disabled:opacity-40"
            >
              收起
            </button>
          </div>

          <div className="space-y-3 mb-4">
            {patches.map((p, i) => (
              <div
                key={`${p.segmentIndex}-${i}`}
                className="rounded-lg border border-zinc-700/60 bg-zinc-900/50 px-4 py-3"
              >
                <p className="text-[11px] text-zinc-500 mb-2">
                  第 {p.segmentIndex} 段 · {p.reason}
                </p>
                <div className="grid gap-2">
                  <div className="text-xs leading-relaxed">
                    <span className="text-red-400/80 mr-1.5">原文</span>
                    <span className="text-zinc-500">
                      {p.originalExcerpt || currentContent.split(/\n\s*\n/).filter(Boolean)[p.segmentIndex - 1]?.slice(0, 80) || '（略）'}
                    </span>
                  </div>
                  <div className="text-xs leading-relaxed">
                    <span className="text-emerald-400/90 mr-1.5">建议</span>
                    <span className="text-zinc-200">{p.revisedText}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {patchError && (
            <p className="text-xs text-red-400 mb-3">{patchError}</p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => handleDecide(true)}
              disabled={deciding}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 transition disabled:opacity-40 disabled:cursor-wait"
            >
              {deciding ? '正在融合…' : '✓ 接受修改'}
            </button>
            <button
              onClick={handleContinueTuning}
              disabled={deciding}
              className="px-4 py-2 rounded-lg text-sm text-zinc-300 border border-zinc-700 hover:border-zinc-500 hover:text-zinc-100 transition disabled:opacity-40"
            >
              继续调整
            </button>
            <button
              onClick={() => handleDecide(false)}
              disabled={deciding}
              className="px-4 py-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-300 transition disabled:opacity-40"
            >
              拒绝修改
            </button>
          </div>
          <p className="text-[11px] text-zinc-600 mt-2.5">
            接受后仅替换标注段落生成新版本；继续调整可补充反馈重新生成建议；拒绝会记入你的修改偏好。
          </p>
        </div>
      ) : null}

      {/* ── 快捷优化方向（6 类预设）── */}
      {state === 'idle' && (
        <div className="mt-6">
          <p className="text-xs text-zinc-500 mb-2">或者直接选择优化方向：</p>
          <div className="flex flex-wrap gap-2">
            {NEXT_ACTION_META.map((m) => (
              <button
                key={m.key}
                onClick={() =>
                  onQuickDirection?.(
                    m.key,
                    m.key === 'custom' ? freeText.trim() || undefined : undefined
                  )
                }
                disabled={disabled}
                title={m.blurb}
                className={`px-3.5 py-2 rounded-lg text-xs font-medium transition border disabled:opacity-40 disabled:cursor-not-allowed ${
                  improvingDirection === m.key
                    ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/40'
                    : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800'
                }`}
              >
                {m.emoji} {m.label}
                {improvingDirection === m.key && (
                  <span className="ml-1.5 inline-block h-2.5 w-2.5 rounded-full border-2 border-current border-t-transparent animate-spin align-[-1px]" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── 提示：非登录用户 ── */}
      {!isLoggedIn && state === 'idle' && (
        <p className="text-xs text-zinc-600 mt-3">
          登录后反馈会被保存到你的作品历史，跨设备可恢复
        </p>
      )}
    </div>
  )
}
