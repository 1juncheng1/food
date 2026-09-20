'use client'

// ============================================================
// AI 创作建议卡（生成页第二层）—— 灵感场重构阶段 B
//
// 6 张建议卡：内容类型（含理由）/ 创作方向 A·B·C / 创作视角 /
// 叙事结构（只读展开细节）/ 语言风格三维 / 预计长度三档。
// 全部字段 AI 已预选，用户可以不改任何东西一键生成；
// 修改是权利，不是作业。
// ============================================================

import { useState } from 'react'
import { CATEGORIES } from '@/lib/constants'
import type {
  CreativePlan,
  PlanDirection,
  PlanEdits,
  PlanLanguageStyle,
  StrategyMode,
} from '@/lib/creative/plan'

interface PlanPanelProps {
  plan: CreativePlan
  /** 本次方案的主题（卡片头部回显） */
  topic: string
  /** 阶段 B：方案已确认（阶段 C 接通真实生成前的锁定态） */
  confirmed: boolean
  onConfirm: (edits: PlanEdits) => void
  onReanalyze: () => void
  /** 2a：非创作类问题——按问题理解直接生成解决方案（跳转 /solution/[id]） */
  onSolve: () => void
  /** 方案态"返回改主题" → 回到输入态 */
  onBack: () => void
  /** 锁定态"返回调整" → 回到方案编辑态 */
  onBackToEdit: () => void
}

/** 通用"值 + 修改"行：编辑态切换为输入框 */
function EditableRow({
  label,
  value,
  editing,
  onStartEdit,
  onCommit,
  onCancel,
  children,
  hint,
}: {
  label: string
  value: React.ReactNode
  editing: boolean
  onStartEdit: () => void
  onCommit: () => void
  onCancel: () => void
  children: React.ReactNode
  hint?: string
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <p className="text-[11px] font-medium text-zinc-500 tracking-wide uppercase">{label}</p>
        {!editing && (
          <button
            type="button"
            onClick={onStartEdit}
            className="shrink-0 text-[11px] text-zinc-500 hover:text-indigo-300 transition"
          >修改</button>
        )}
      </div>
      {editing ? (
        <div className="mt-3 space-y-3">
          {children}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCommit}
              className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg transition"
            >完成</button>
            <button
              type="button"
              onClick={onCancel}
              className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg transition"
            >取消</button>
          </div>
        </div>
      ) : (
        <div className="mt-2 text-sm text-zinc-200 leading-relaxed">{value}</div>
      )}
      {!editing && hint && <p className="mt-1.5 text-xs text-zinc-500 leading-relaxed">{hint}</p>}
    </div>
  )
}

const inputCls =
  'w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none transition'

/** 战略模式元数据：标签文案 + 配色 */
const STRATEGY_MODE_META: Record<StrategyMode, { label: string; desc: string; className: string }> = {
  market_ref: {
    label: '模式A · 市场参考',
    desc: '学习爆款结构',
    className: 'bg-sky-500/10 border-sky-500/30 text-sky-200',
  },
  differentiation: {
    label: '模式B · 差异化',
    desc: '换切入角度避开红海',
    className: 'bg-violet-500/10 border-violet-500/30 text-violet-200',
  },
  personal_ip: {
    label: '模式C · 个人IP',
    desc: '强化你的创作风格',
    className: 'bg-amber-500/10 border-amber-500/30 text-amber-200',
  },
}

/** 内容战略块："为什么这样写"（创作目标 / 推荐模式 / 需要资料 / 风险提醒） */
function StrategyBlock({ plan }: { plan: CreativePlan }) {
  const strategy = plan.strategy
  if (!strategy) return null

  const modeMeta = STRATEGY_MODE_META[strategy.recommended_mode]

  return (
    <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[11px] font-medium text-emerald-300 tracking-wide uppercase">
          内容战略 · 为什么这样写
        </p>
        <span className="text-[10px] text-zinc-500">
          {strategy.goal_source === 'clarified' ? '创作目标来自你的确认' : '创作目标为 AI 推断，可在澄清时修正'}
        </span>
      </div>

      {/* 创作目标 + 推荐模式 */}
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <p className="text-xs text-zinc-500 mb-1">创作目标</p>
          <p className="text-sm text-zinc-200 leading-relaxed">{strategy.goal}</p>
        </div>
        <div className={`rounded-lg border p-3 ${modeMeta.className}`}>
          <p className="text-xs opacity-70 mb-1">推荐模式</p>
          <p className="text-sm font-medium">{modeMeta.label}</p>
          <p className="text-xs opacity-70 mt-1 leading-relaxed">{strategy.mode_reason}</p>
        </div>
      </div>

      {/* 需要资料 */}
      {strategy.materials_needed.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-zinc-500 mb-1.5">开始创作前建议准备</p>
          <ul className="space-y-1">
            {strategy.materials_needed.map((m, i) => (
              <li key={i} className="text-xs text-zinc-300 flex items-start gap-1.5">
                <span className="shrink-0 text-emerald-400/70">·</span>
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 风险提醒 */}
      {strategy.risk_warnings.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
          <p className="text-xs text-amber-300 font-medium mb-1.5">风险提醒</p>
          <ul className="space-y-1">
            {strategy.risk_warnings.map((r, i) => (
              <li key={i} className="text-xs text-zinc-400 flex items-start gap-1.5">
                <span className="shrink-0 text-amber-400/70">⚠</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function PlanPanel({
  plan,
  topic,
  confirmed,
  onConfirm,
  onReanalyze,
  onSolve,
  onBack,
  onBackToEdit,
}: PlanPanelProps) {
  const [dirKey, setDirKey] = useState(plan.recommended_direction_key)
  const [contentType, setContentType] = useState(plan.content_type)
  const [contentTypeDraft, setContentTypeDraft] = useState(plan.content_type)
  const [editingType, setEditingType] = useState(false)
  const [viewpoint, setViewpoint] = useState('')
  const [viewpointDraft, setViewpointDraft] = useState('')
  const [editingViewpoint, setEditingViewpoint] = useState(false)
  const [langStyle, setLangStyle] = useState<PlanLanguageStyle | null>(null)
  const [langDraft, setLangDraft] = useState<PlanLanguageStyle | null>(null)
  const [editingStyle, setEditingStyle] = useState(false)
  const [wordCount, setWordCount] = useState(plan.recommended_word_count)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const direction: PlanDirection =
    plan.directions.find((d) => d.key === dirKey) ?? plan.directions[0]

  // 切换方向：视角/语言风格随该方向整体替换。
  // React 官方推荐的"渲染期间调整 state"模式（记录上一个 dirKey，变化即重置派生编辑态）。
  const [prevDirKey, setPrevDirKey] = useState(plan.recommended_direction_key)
  if (dirKey !== prevDirKey) {
    setPrevDirKey(dirKey)
    setViewpoint(direction.viewpoint)
    setLangStyle(direction.language_style)
    setEditingViewpoint(false)
    setEditingStyle(false)
    setDetailsOpen(false)
  }

  async function copyPrompt() {
    const text = plan.problem?.professional_prompt
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用（如非 HTTPS 环境）时静默，用户可手动选中复制
    }
  }

  function handleConfirm() {
    const edits: PlanEdits = {
      directionKey: dirKey,
      contentType: contentType.trim() || plan.content_type,
      viewpoint: viewpoint.trim() || direction.viewpoint,
      wordCount,
      languageStyle: langStyle ?? direction.language_style,
    }
    onConfirm(edits)
  }

  return (
    <div className="space-y-5">
      {/* 头部 */}
      <div className="flex items-center gap-2">
        <span className="text-xl">🧭</span>
        <div>
          <h2 className="text-lg font-semibold text-white leading-tight">AI 创作建议</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            基于《{topic.slice(0, 40)}》为你设计，每项都可以修改
          </p>
        </div>
      </div>

      {/* ⓪ 问题理解：AI 先理解"你想解决什么问题"（问题分析层核心产物） */}
      {plan.problem && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-medium text-zinc-500 tracking-wide uppercase">
              问题理解
              <span className="ml-2 normal-case tracking-normal text-zinc-600">AI 对你想解决什么问题的拆解</span>
            </p>
            {plan.problem.problem_type && (
              <span className="shrink-0 text-[10px] text-indigo-200 bg-indigo-500/15 border border-indigo-500/30 px-2 py-0.5 rounded-full">
                {plan.problem.problem_type}
              </span>
            )}
          </div>

          {/* 非创作类：诚实告知当前生成边界 */}
          {!plan.problem.is_content_creation && (
            <div className="mt-3 flex gap-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5">
              <span className="text-xs shrink-0">💡</span>
              <p className="text-xs text-amber-200/90 leading-relaxed">
                这个问题的成品生成即将支持。你可以先把下方「专业 Prompt」复制给任意 AI 工具直接使用。
              </p>
            </div>
          )}

          <div className="mt-4 space-y-3">
            <DetailLine label="你的目标" value={plan.problem.user_goal} />
            {plan.problem.task_breakdown.length > 0 && (
              <div>
                <p className="text-[11px] text-zinc-500 mb-1.5">需要解决的核心任务</p>
                <ol className="space-y-1.5">
                  {plan.problem.task_breakdown.map((t, i) => (
                    <li key={i} className="flex gap-2.5 text-sm text-zinc-300 leading-relaxed">
                      <span className="shrink-0 w-5 h-5 rounded-full bg-indigo-500/15 text-indigo-300 text-xs flex items-center justify-center mt-0.5">
                        {i + 1}
                      </span>
                      <span>{t}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <DetailLine label="你的身份与所需表达" value={plan.problem.user_identity} />
            {plan.problem.recommended_role && (
              <div>
                <p className="text-[11px] text-zinc-500 mb-0.5">建议 AI 扮演的角色</p>
                <p className="text-sm text-zinc-300 leading-relaxed">{plan.problem.recommended_role}</p>
                {plan.problem.role_reason && (
                  <p className="text-xs text-zinc-600 mt-0.5">{plan.problem.role_reason}</p>
                )}
              </div>
            )}
            <DetailLine label="怎样算做好" value={plan.problem.success_criteria} />

            {/* 专业 Prompt：折叠展开 + 一键复制 */}
            {plan.problem.professional_prompt && (
              <div className="pt-3 border-t border-zinc-800/70">
                <button
                  type="button"
                  onClick={() => setPromptOpen(!promptOpen)}
                  className="w-full flex items-center justify-between text-left"
                >
                  <p className="text-[11px] font-medium text-zinc-500 tracking-wide uppercase">
                    专业 Prompt
                    <span className="ml-2 normal-case tracking-normal text-zinc-600">可直接复制给任何 AI 使用</span>
                  </p>
                  <span className={`text-zinc-500 text-xs transition-transform duration-300 ${promptOpen ? 'rotate-180' : ''}`}>▾</span>
                </button>
                {promptOpen && (
                  <>
                    <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-xs text-zinc-300 leading-relaxed font-sans">
                      {plan.problem.professional_prompt}
                    </pre>
                    <button
                      type="button"
                      onClick={copyPrompt}
                      className="mt-2.5 text-xs border border-zinc-800 hover:border-indigo-500/50 hover:text-indigo-300 text-zinc-300 px-3.5 py-2 rounded-lg transition"
                    >
                      {copied ? '✓ 已复制' : '复制 Prompt'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 个性化证据句：仅我的模式且有真实依据时出现 */}
      {plan.personal_reason && (
        <div className="flex gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-5 py-4">
          <span className="text-base shrink-0">🧠</span>
          <p className="text-xs sm:text-sm text-indigo-200/90 leading-relaxed">
            {plan.personal_reason}
          </p>
        </div>
      )}

      {/* 内容战略块：为什么这样写（LLM 偶发漏字段时整体省略） */}
      <StrategyBlock plan={plan} />

      {/* ① 内容类型 */}
      <EditableRow
        label="内容类型"
        value={
          <span className="inline-flex items-center gap-2">
            <span className="text-indigo-200 font-medium text-base">{contentType}</span>
          </span>
        }
        hint={plan.content_type_reason ? `适合原因：${plan.content_type_reason}` : undefined}
        editing={editingType}
        onStartEdit={() => { setContentTypeDraft(contentType); setEditingType(true) }}
        onCommit={() => { if (contentTypeDraft.trim()) setContentType(contentTypeDraft.trim()); setEditingType(false) }}
        onCancel={() => setEditingType(false)}
      >
        <input
          type="text" value={contentTypeDraft}
          onChange={(e) => setContentTypeDraft(e.target.value)}
          maxLength={30}
          className={inputCls}
          placeholder="输入你想要的内容类型"
        />
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setContentTypeDraft(c)}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition ${
                contentTypeDraft === c
                  ? 'border-indigo-500 text-indigo-200 bg-indigo-500/15'
                  : 'border-zinc-800 text-zinc-400 hover:border-zinc-600'
              }`}
            >{c}</button>
          ))}
        </div>
      </EditableRow>

      {/* ② 创作方向 A/B/C */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <p className="text-[11px] font-medium text-zinc-500 tracking-wide uppercase">
          创作方向
          <span className="ml-2 normal-case tracking-normal text-zinc-600">选一个最想写的</span>
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
          {plan.directions.map((d) => {
            const selected = d.key === dirKey
            const recommended = d.key === plan.recommended_direction_key
            const modeMeta = d.strategy_mode ? STRATEGY_MODE_META[d.strategy_mode] : null
            return (
              <button
                key={d.key}
                type="button"
                onClick={() => setDirKey(d.key)}
                aria-pressed={selected}
                className={`relative text-left p-4 rounded-xl border transition-colors duration-200 ${
                  selected
                    ? 'border-indigo-500 bg-indigo-600/10'
                    : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`shrink-0 w-6 h-6 rounded-full text-xs flex items-center justify-center font-medium ${
                      selected ? 'bg-indigo-500 text-white' : 'bg-zinc-800 text-zinc-400'
                    }`}
                  >{d.key}</span>
                  <span className={`text-sm font-medium leading-snug ${selected ? 'text-white' : 'text-zinc-300'}`}>
                    {d.title}
                  </span>
                </div>
                {modeMeta && (
                  <span
                    className={`inline-block mt-2 text-[10px] px-1.5 py-0.5 rounded border ${modeMeta.className}`}
                    title={modeMeta.desc}
                  >
                    {modeMeta.label}
                  </span>
                )}
                <p className="text-xs text-zinc-500 mt-2 leading-relaxed line-clamp-4">{d.desc}</p>
                {recommended && (
                  <span className="absolute top-3 right-3 text-[10px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">
                    AI 推荐
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* ③ 创作视角 */}
      <EditableRow
        label="创作视角"
        value={<span className="text-zinc-100">{viewpoint}</span>}
        hint="视角是「从什么角度切入」，不是身份标签——你始终是作者。"
        editing={editingViewpoint}
        onStartEdit={() => { setViewpointDraft(viewpoint); setEditingViewpoint(true) }}
        onCommit={() => { if (viewpointDraft.trim()) setViewpoint(viewpointDraft.trim()); setEditingViewpoint(false) }}
        onCancel={() => setEditingViewpoint(false)}
      >
        <textarea
          value={viewpointDraft}
          onChange={(e) => setViewpointDraft(e.target.value)}
          rows={2}
          maxLength={100}
          className={`${inputCls} resize-none`}
          placeholder="例：从人物心理分析电影 / 按三幕结构拆解剧情"
        />
      </EditableRow>

      {/* ④ 叙事结构（只读 + 可展开完整方案细节） */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <button
          type="button"
          onClick={() => setDetailsOpen(!detailsOpen)}
          className="w-full flex items-center justify-between text-left"
        >
          <p className="text-[11px] font-medium text-zinc-500 tracking-wide uppercase">
            叙事结构
            <span className="ml-2 normal-case tracking-normal text-zinc-600">
              {direction.structure.length} 个段落 · {detailsOpen ? '收起细节' : '展开完整构思'}
            </span>
          </p>
          <span className={`text-zinc-500 text-xs transition-transform duration-300 ${detailsOpen ? 'rotate-180' : ''}`}>▾</span>
        </button>

        <ol className="mt-3 space-y-2">
          {direction.structure.map((step, i) => (
            <li key={i} className="flex gap-3 text-sm text-zinc-300 leading-relaxed">
              <span className="shrink-0 w-5 h-5 rounded-full bg-indigo-500/15 text-indigo-300 text-xs flex items-center justify-center mt-0.5">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        {detailsOpen && (
          <div className="mt-4 pt-4 border-t border-zinc-800/70 space-y-3">
            {plan.target_audience && (
              <DetailLine label="目标观众" value={plan.target_audience} />
            )}
            <DetailLine label="情绪曲线" value={direction.emotion_curve} />
            <DetailLine label="开头 Hook" value={direction.opening_hook} />
            <DetailLine label="核心冲突" value={direction.core_conflict} />
            <DetailLine label="结尾升华" value={direction.ending} />
            <DetailLine label="创作策略" value={direction.strategy} />
          </div>
        )}
      </div>

      {/* ⑤ 语言风格 */}
      <EditableRow
        label="语言风格"
        value={
          <div className="flex flex-wrap gap-2">
            <StyleChip label="节奏" value={langStyle?.pace} />
            <StyleChip label="情绪" value={langStyle?.mood} />
            <StyleChip label="表达" value={langStyle?.expression} />
          </div>
        }
        editing={editingStyle}
        onStartEdit={() => {
          setLangDraft(langStyle ? { ...langStyle } : { pace: '', mood: '', expression: '' })
          setEditingStyle(true)
        }}
        onCommit={() => {
          if (langDraft) {
            setLangStyle({
              pace: langDraft.pace.trim() || direction.language_style.pace,
              mood: langDraft.mood.trim() || direction.language_style.mood,
              expression: langDraft.expression.trim() || direction.language_style.expression,
            })
          }
          setEditingStyle(false)
        }}
        onCancel={() => setEditingStyle(false)}
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <p className="text-[11px] text-zinc-500 mb-1.5">节奏</p>
            <input
              type="text" value={langDraft?.pace ?? ''}
              onChange={(e) => setLangDraft((p) => ({ pace: e.target.value, mood: p?.mood ?? '', expression: p?.expression ?? '' }))}
              maxLength={10} className={inputCls} placeholder="快速 / 舒缓"
            />
          </div>
          <div>
            <p className="text-[11px] text-zinc-500 mb-1.5">情绪</p>
            <input
              type="text" value={langDraft?.mood ?? ''}
              onChange={(e) => setLangDraft((p) => ({ pace: p?.pace ?? '', mood: e.target.value, expression: p?.expression ?? '' }))}
              maxLength={10} className={inputCls} placeholder="紧张 / 温情"
            />
          </div>
          <div>
            <p className="text-[11px] text-zinc-500 mb-1.5">表达</p>
            <input
              type="text" value={langDraft?.expression ?? ''}
              onChange={(e) => setLangDraft((p) => ({ pace: p?.pace ?? '', mood: p?.mood ?? '', expression: e.target.value }))}
              maxLength={10} className={inputCls} placeholder="故事化 / 深度分析"
            />
          </div>
        </div>
      </EditableRow>

      {/* ⑥ 预计长度 */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <p className="text-[11px] font-medium text-zinc-500 tracking-wide uppercase">预计长度</p>
        <div className="flex flex-wrap gap-3 mt-3">
          {plan.word_count_options.map((w) => {
            const selected = w === wordCount
            const recommended = w === plan.recommended_word_count
            return (
              <button
                key={w}
                type="button"
                onClick={() => setWordCount(w)}
                className={`relative px-5 py-2.5 rounded-xl border text-sm transition ${
                  selected
                    ? 'border-indigo-500 bg-indigo-600/10 text-white'
                    : 'border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                {w} 字
                {recommended && (
                  <span className="absolute -top-2 left-3 text-[10px] text-amber-300/90 bg-zinc-900 px-1">推荐</span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* 底部操作 */}
      {confirmed ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-4 flex items-center justify-between gap-3">
          <p className="text-sm text-emerald-200">✅ 方案已锁定，下一阶段将从此处直接开始生成文章</p>
          <button
            type="button"
            onClick={onBackToEdit}
            className="shrink-0 text-xs text-emerald-300/80 hover:text-emerald-200 transition"
          >返回调整</button>
        </div>
      ) : plan.problem && !plan.problem.is_content_creation ? (
        // 非创作类：主行动 = 直接生成解决方案（2a 通用求解适配器）；
        // 专业 Prompt 复制保留在上方卡片内；生成降级为逃生门（AI 误判时可强制走内容方案）
        <div className="flex flex-col gap-3 pt-1">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="text-sm text-zinc-500 hover:text-zinc-300 transition order-3 sm:order-1"
            >← 返回改主题</button>
            <button
              type="button"
              onClick={onReanalyze}
              className="text-sm text-zinc-300 border border-zinc-800 hover:border-zinc-600 px-4 py-3 rounded-xl transition order-2"
            >🔄 重新分析</button>
            <button
              type="button"
              onClick={onSolve}
              className="flex-1 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 py-3.5 rounded-xl font-semibold text-base text-white transition shadow-lg shadow-indigo-900/30 order-1 sm:order-3"
            >
              使用方案，开始解决
            </button>
          </div>
          <button
            type="button"
            onClick={handleConfirm}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition self-center"
          >
            我认为这也能做成内容，按下方方案直接生成 →
          </button>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-zinc-500 hover:text-zinc-300 transition order-3 sm:order-1"
          >← 返回改主题</button>
          <button
            type="button"
            onClick={onReanalyze}
            className="text-sm text-zinc-300 border border-zinc-800 hover:border-zinc-600 px-4 py-3 rounded-xl transition order-2"
          >🔄 重新分析</button>
          <button
            type="button"
            onClick={handleConfirm}
            className="flex-1 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 py-3.5 rounded-xl font-semibold text-base text-white transition shadow-lg shadow-indigo-900/30 order-1 sm:order-3"
          >
            使用方案，生成文章
          </button>
        </div>
      )}
    </div>
  )
}

function StyleChip({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <span className="inline-flex items-center gap-1.5 text-xs border border-zinc-800 rounded-full pl-2.5 pr-3 py-1">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-200">{value}</span>
    </span>
  )
}

function DetailLine({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div>
      <p className="text-[11px] text-zinc-500 mb-0.5">{label}</p>
      <p className="text-sm text-zinc-300 leading-relaxed">{value}</p>
    </div>
  )
}
