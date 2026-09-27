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
import Link from 'next/link'
import { CATEGORIES } from '@/lib/constants'
import type {
  CreativePlan,
  PlanDirection,
  PlanEdits,
  PlanLanguageStyle,
  StrategyMode,
} from '@/lib/creative/plan'
import { WORD_COUNT_MAX, WORD_COUNT_MIN, clampWordCount } from '@/lib/creative/wordCount'
// 仅类型导入：编译后被擦除，不会把服务端注入模块打进浏览器包
import type { InjectedUnitSummary } from '@/lib/creative/knowledgeInject'

interface PlanPanelProps {
  plan: CreativePlan
  /** 本次方案的主题（卡片头部回显） */
  topic: string
  /**
   * Creator Knowledge System Phase 3：本次方案实际参考的知识单元。
   * 为空数组时不渲染该卡片 —— 没有用到就是没有用到，不给假徽标。
   */
  knowledgeUnits: InjectedUnitSummary[]
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
    <div className="vs-sec">
      <div className="flex items-start justify-between gap-4">
        <p className="vs-mark">{label}</p>
        {!editing && (
          <button type="button" onClick={onStartEdit} className="vs-link shrink-0">
            修改
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-3 space-y-3">
          {children}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCommit}
              className="vs-btn vs-btn-primary vs-btn-sm"
            >
              完成
            </button>
            <button type="button" onClick={onCancel} className="vs-btn vs-btn-ghost vs-btn-sm">
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 text-[15px] leading-relaxed text-[var(--vs-ink)]">{value}</div>
      )}
      {!editing && hint && <p className="vs-note mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  )
}

const inputCls = 'vs-input vs-input-field'

/**
 * 战略模式元数据：只留文案。
 * 三种模式是三个选项，不是三种状态 —— 配色交回 UI 层统一，不再各自染色。
 */
const STRATEGY_MODE_META: Record<StrategyMode, { label: string; desc: string }> = {
  market_ref: { label: '模式A · 市场参考', desc: '学习爆款结构' },
  differentiation: { label: '模式B · 差异化', desc: '换切入角度避开红海' },
  personal_ip: { label: '模式C · 个人IP', desc: '强化你的创作风格' },
}

/** 内容战略块："为什么这样写"（创作目标 / 推荐模式 / 需要资料 / 风险提醒） */
function StrategyBlock({ plan }: { plan: CreativePlan }) {
  const strategy = plan.strategy
  if (!strategy) return null

  const modeMeta = STRATEGY_MODE_META[strategy.recommended_mode]

  return (
    <div className="vs-sec">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="vs-mark">内容战略 · 为什么这样写</p>
        <span className="vs-note">
          {strategy.goal_source === 'clarified' ? '创作目标来自你的确认' : '创作目标为 AI 推断，可在澄清时修正'}
        </span>
      </div>

      {/* 创作目标 + 推荐模式 */}
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
        <div className="border-t border-[var(--vs-line)] pt-3">
          <p className="vs-note">创作目标</p>
          <p className="mt-1.5 text-[14px] leading-relaxed text-[var(--vs-ink-2)]">
            {strategy.goal}
          </p>
        </div>
        <div className="border-t border-[var(--vs-line)] pt-3">
          <p className="vs-note">推荐模式</p>
          <p className="mt-1.5 text-[14px] font-medium text-[var(--vs-ink)]">{modeMeta.label}</p>
          <p className="vs-note mt-1 leading-relaxed">{strategy.mode_reason}</p>
        </div>
      </div>

      {/* 需要资料 */}
      {strategy.materials_needed.length > 0 && (
        <div className="mt-4">
          <p className="vs-note">开始创作前建议准备</p>
          <ul className="mt-1.5 space-y-1">
            {strategy.materials_needed.map((m, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--vs-ink-2)]"
              >
                <span className="shrink-0 text-[var(--vs-ink-5)]">·</span>
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 风险提醒 */}
      {strategy.risk_warnings.length > 0 && (
        <div className="vs-warn mt-4">
          <p className="vs-note vs-note-warn">风险提醒</p>
          <ul className="mt-1.5 space-y-1">
            {strategy.risk_warnings.map((r, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--vs-ink-3)]"
              >
                <span className="shrink-0 text-[var(--vs-ink-5)]">·</span>
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
  knowledgeUnits,
  confirmed,
  onConfirm,
  onReanalyze,
  onSolve,
  onBack,
  onBackToEdit,
}: PlanPanelProps) {
  // AI 推荐方向：所有"随方向派生"的编辑态都以它作为初始值。
  // 此前 viewpoint/langStyle 初始为空串/null，只有用户手动切换方向才会赋值，
  // 导致首次进入方案态时"创作视角"和"语言风格"显示为空。
  const initialDirection: PlanDirection =
    plan.directions.find((d) => d.key === plan.recommended_direction_key) ?? plan.directions[0]

  const [dirKey, setDirKey] = useState(plan.recommended_direction_key)
  const [contentType, setContentType] = useState(plan.content_type)
  const [contentTypeDraft, setContentTypeDraft] = useState(plan.content_type)
  const [editingType, setEditingType] = useState(false)
  const [viewpoint, setViewpoint] = useState(initialDirection.viewpoint)
  const [viewpointDraft, setViewpointDraft] = useState(initialDirection.viewpoint)
  const [editingViewpoint, setEditingViewpoint] = useState(false)
  const [langStyle, setLangStyle] = useState<PlanLanguageStyle | null>(initialDirection.language_style)
  const [langDraft, setLangDraft] = useState<PlanLanguageStyle | null>(initialDirection.language_style)
  const [editingStyle, setEditingStyle] = useState(false)
  const [wordCount, setWordCount] = useState(plan.recommended_word_count)
  // 自定义字数草稿：只在合法区间内提交，保证"边打字边改"不被清成空。
  // 选档按钮改字数时用渲染期同步回写草稿（不用 effect，避免级联渲染）。
  const [wordDraft, setWordDraft] = useState(String(plan.recommended_word_count))
  const [syncedWordCount, setSyncedWordCount] = useState(plan.recommended_word_count)
  if (syncedWordCount !== wordCount) {
    setSyncedWordCount(wordCount)
    setWordDraft(String(wordCount))
  }
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
      <div>
        <h2 className="vs-h3">AI 创作建议</h2>
        <p className="vs-note mt-1">
          基于《{topic.slice(0, 40)}》为你设计，每项都可以修改
        </p>
      </div>

      {/* Creator Knowledge System Phase 3：本次方案用了创作者哪些已确认的知识。
          放在最靠前的位置——用户第一眼就该知道 AI 这次是"拿着什么在帮他想"，
          这是判断方案能不能信的第一道关，不该藏在折叠面板里。 */}
      {knowledgeUnits.length > 0 && (
        <div className="vs-sec">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="vs-mark">本次参考了你的 {knowledgeUnits.length} 条知识</p>
            <Link href="/knowledge" className="vs-link shrink-0">
              去管理 →
            </Link>
          </div>

          <ul className="mt-3 space-y-2.5">
            {knowledgeUnits.map((u, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="shrink-0 mt-2 text-[var(--vs-ink-5)]">·</span>
                <div className="min-w-0">
                  <span className="text-[13px] text-[var(--vs-ink)]">{u.concept}</span>
                  {u.kind && <span className="vs-note ml-1.5">{u.kind}</span>}
                  <p className="vs-note mt-0.5 leading-relaxed">{u.claim}</p>
                </div>
              </li>
            ))}
          </ul>

          <p className="vs-note mt-3 leading-relaxed">
            命题来自你多条素材的交叉印证且经你逐条确认，AI 已作为可信论据；名单之外的主张不会代你编写。
          </p>
        </div>
      )}

      {/* ⓪ 问题理解：AI 先理解"你想解决什么问题"（问题分析层核心产物） */}
      {plan.problem && (
        <div className="vs-sec">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="vs-mark">
              问题理解
              <span className="ml-2 normal-case tracking-normal text-[var(--vs-ink-5)]">
                AI 对你想解决什么问题的拆解
              </span>
            </p>
            {plan.problem.problem_type && (
              <span className="vs-verdict shrink-0">{plan.problem.problem_type}</span>
            )}
          </div>

          {/* 非创作类：诚实告知当前生成边界 */}
          {!plan.problem.is_content_creation && (
            <div className="vs-warn mt-3">
              <p className="vs-note vs-note-warn leading-relaxed">
                这个问题的成品生成即将支持。你可以先把下方「专业 Prompt」复制给任意 AI 工具直接使用。
              </p>
            </div>
          )}

          <div className="mt-4 space-y-3">
            <DetailLine label="你的目标" value={plan.problem.user_goal} />
            {plan.problem.task_breakdown.length > 0 && (
              <div className="mt-4">
                <p className="vs-note">需要解决的核心任务</p>
                <ol className="mt-1.5 space-y-1.5">
                  {plan.problem.task_breakdown.map((t, i) => (
                    <li
                      key={i}
                      className="flex gap-3 text-[14px] leading-relaxed text-[var(--vs-ink-2)]"
                    >
                      <span className="vs-num shrink-0 text-[var(--vs-ink-4)]">{i + 1}</span>
                      <span>{t}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <DetailLine label="你的身份与所需表达" value={plan.problem.user_identity} />
            {plan.problem.recommended_role && (
              <div className="mt-4">
                <p className="vs-note">建议 AI 扮演的角色</p>
                <p className="mt-1 text-[14px] leading-relaxed text-[var(--vs-ink-2)]">
                  {plan.problem.recommended_role}
                </p>
                {plan.problem.role_reason && (
                  <p className="vs-note mt-1">{plan.problem.role_reason}</p>
                )}
              </div>
            )}
            <DetailLine label="怎样算做好" value={plan.problem.success_criteria} />

            {/* 专业 Prompt：折叠展开 + 一键复制 */}
            {plan.problem.professional_prompt && (
              <div className="pt-4 border-t border-[var(--vs-line)]">
                <button
                  type="button"
                  onClick={() => setPromptOpen(!promptOpen)}
                  className="w-full flex items-center justify-between gap-3 text-left"
                >
                  <p className="vs-mark">
                    专业 Prompt
                    <span className="ml-2 normal-case tracking-normal text-[var(--vs-ink-5)]">
                      可直接复制给任何 AI 使用
                    </span>
                  </p>
                  <span
                    className={`vs-note inline-block transition-transform duration-300 ${
                      promptOpen ? 'rotate-180' : ''
                    }`}
                  >
                    ▾
                  </span>
                </button>
                {promptOpen && (
                  <>
                    <pre className="mt-3 whitespace-pre-wrap break-words border-l border-[var(--vs-line-2)] pl-4 font-sans text-[13px] leading-relaxed text-[var(--vs-ink-2)]">
                      {plan.problem.professional_prompt}
                    </pre>
                    <button
                      type="button"
                      onClick={copyPrompt}
                      className="vs-btn vs-btn-ghost vs-btn-sm mt-3"
                    >
                      {copied ? '已复制' : '复制 Prompt'}
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
        <div className="vs-sec">
          <p className="vs-mark">为什么为你这样设计</p>
          <p className="mt-2 text-[14px] leading-relaxed text-[var(--vs-ink-2)]">
            {plan.personal_reason}
          </p>
        </div>
      )}

      {/* 内容战略块：为什么这样写（LLM 偶发漏字段时整体省略） */}
      <StrategyBlock plan={plan} />

      {/* ① 内容类型 */}
      <EditableRow
        label="内容类型"
        value={<span className="font-medium text-[17px]">{contentType}</span>}
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
              data-on={contentTypeDraft === c}
              className="vs-chip"
            >
              {c}
            </button>
          ))}
        </div>
      </EditableRow>

      {/* ② 创作方向 A/B/C */}
      <div className="vs-sec">
        <p className="vs-mark">
          创作方向
          <span className="ml-2 normal-case tracking-normal text-[var(--vs-ink-5)]">
            选一个最想写的
          </span>
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
                className={`relative text-left p-4 rounded-[var(--vs-r)] border transition-colors duration-200 ${
                  selected
                    ? 'border-[var(--vs-beam-line)] bg-[var(--vs-beam-wash)]'
                    : 'border-[var(--vs-line)] bg-transparent hover:border-[var(--vs-line-2)]'
                }`}
              >
                <div className="flex items-start gap-2">
                  <span
                    className={`vs-num shrink-0 text-[13px] ${
                      selected ? 'text-[var(--vs-beam-text)]' : 'text-[var(--vs-ink-4)]'
                    }`}
                  >
                    {d.key}
                  </span>
                  <span
                    className={`text-[14px] font-medium leading-snug ${
                      selected ? 'text-[var(--vs-ink)]' : 'text-[var(--vs-ink-2)]'
                    }`}
                  >
                    {d.title}
                  </span>
                </div>
                {modeMeta && (
                  <span className="vs-verdict mt-2 inline-block" title={modeMeta.desc}>
                    {modeMeta.label}
                  </span>
                )}
                <p className="vs-note mt-2 leading-relaxed line-clamp-4">{d.desc}</p>
                {recommended && <span className="vs-note absolute top-3 right-3">AI 推荐</span>}
              </button>
            )
          })}
        </div>
      </div>

      {/* ③ 创作视角 */}
      <EditableRow
        label="创作视角"
        value={<span>{viewpoint}</span>}
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
      <div className="vs-sec">
        <button
          type="button"
          onClick={() => setDetailsOpen(!detailsOpen)}
          className="w-full flex items-center justify-between gap-3 text-left"
        >
          <p className="vs-mark">
            叙事结构
            <span className="ml-2 normal-case tracking-normal text-[var(--vs-ink-5)]">
              {direction.structure.length} 个段落 · {detailsOpen ? '收起细节' : '展开完整构思'}
            </span>
          </p>
          <span
            className={`vs-note inline-block transition-transform duration-300 ${
              detailsOpen ? 'rotate-180' : ''
            }`}
          >
            ▾
          </span>
        </button>

        <ol className="mt-3 space-y-2">
          {direction.structure.map((step, i) => (
            <li
              key={i}
              className="flex gap-3 text-[14px] leading-relaxed text-[var(--vs-ink-2)]"
            >
              <span className="vs-num shrink-0 text-[var(--vs-ink-4)]">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        {detailsOpen && (
          <div className="mt-4 pt-4 border-t border-[var(--vs-line)] space-y-3">
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className="vs-note mb-1.5">节奏</p>
            <input
              type="text" value={langDraft?.pace ?? ''}
              onChange={(e) => setLangDraft((p) => ({ pace: e.target.value, mood: p?.mood ?? '', expression: p?.expression ?? '' }))}
              maxLength={10} className={inputCls} placeholder="快速 / 舒缓"
            />
          </div>
          <div>
            <p className="vs-note mb-1.5">情绪</p>
            <input
              type="text" value={langDraft?.mood ?? ''}
              onChange={(e) => setLangDraft((p) => ({ pace: p?.pace ?? '', mood: e.target.value, expression: p?.expression ?? '' }))}
              maxLength={10} className={inputCls} placeholder="紧张 / 温情"
            />
          </div>
          <div>
            <p className="vs-note mb-1.5">表达</p>
            <input
              type="text" value={langDraft?.expression ?? ''}
              onChange={(e) => setLangDraft((p) => ({ pace: p?.pace ?? '', mood: p?.mood ?? '', expression: e.target.value }))}
              maxLength={10} className={inputCls} placeholder="故事化 / 深度分析"
            />
          </div>
        </div>
      </EditableRow>

      {/* ⑥ 预计长度 */}
      <div className="vs-sec">
        <p className="vs-mark">预计长度</p>
        <div className="flex flex-wrap gap-3 mt-3">
          {plan.word_count_options.map((w) => {
            const selected = w === wordCount
            const recommended = w === plan.recommended_word_count
            return (
              <button
                key={w}
                type="button"
                onClick={() => setWordCount(w)}
                className={`px-5 py-2.5 rounded-[var(--vs-r)] border text-[14px] transition ${
                  selected
                    ? 'border-[var(--vs-beam-line)] bg-[var(--vs-beam-wash)] text-[var(--vs-ink)]'
                    : 'border-[var(--vs-line)] bg-transparent text-[var(--vs-ink-3)] hover:border-[var(--vs-line-2)]'
                }`}
              >
                <span className="vs-num">{w}</span> 字
                {recommended && <span className="vs-note ml-1.5">推荐</span>}
              </button>
            )
          })}
        </div>

        {/* 自定义字数：三档之外用户可自己定，冻结方案与正文都按它走 */}
        <div className="flex items-center gap-2.5 mt-3.5">
          <input
            type="number"
            inputMode="numeric"
            aria-label="自定义目标字数"
            min={WORD_COUNT_MIN}
            max={WORD_COUNT_MAX}
            value={wordDraft}
            onChange={(e) => {
              setWordDraft(e.target.value)
              const next = clampWordCount(e.target.value)
              if (next !== null) setWordCount(next)
            }}
            className={`${inputCls} w-[132px]`}
            placeholder={`${WORD_COUNT_MIN}-${WORD_COUNT_MAX}`}
          />
          <span className="vs-note">字（自定义，{WORD_COUNT_MIN}-{WORD_COUNT_MAX}）</span>
        </div>
      </div>

      {/* 底部操作 */}
      {confirmed ? (
        <div className="vs-sec flex flex-wrap items-center justify-between gap-3">
          <p className="text-[14px] text-[var(--vs-ink-2)]">
            <span className="vs-verdict mr-2">已锁定</span>
            下一阶段将从此处直接开始生成文章
          </p>
          <button type="button" onClick={onBackToEdit} className="vs-link shrink-0">
            返回调整
          </button>
        </div>
      ) : plan.problem && !plan.problem.is_content_creation ? (
        // 非创作类：主行动 = 直接生成解决方案（2a 通用求解适配器）；
        // 专业 Prompt 复制保留在上方卡片内；生成降级为逃生门（AI 误判时可强制走内容方案）
        <div className="flex flex-col gap-3 pt-1">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="vs-link order-3 sm:order-1"
            >
              ← 返回改主题
            </button>
            <button type="button" onClick={onReanalyze} className="vs-btn vs-btn-ghost order-2">
              重新分析
            </button>
            <button
              type="button"
              onClick={onSolve}
              className="vs-btn vs-btn-primary flex-1 order-1 sm:order-3"
            >
              使用方案，开始解决
            </button>
          </div>
          <button type="button" onClick={handleConfirm} className="vs-link self-center">
            我认为这也能做成内容，按下方方案直接生成 →
          </button>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
          <button
            type="button"
            onClick={onBack}
            className="vs-link order-3 sm:order-1"
          >
            ← 返回改主题
          </button>
          <button type="button" onClick={onReanalyze} className="vs-btn vs-btn-ghost order-2">
            重新分析
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="vs-btn vs-btn-primary flex-1 order-1 sm:order-3"
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
    <span className="vs-chip">
      <span className="text-[var(--vs-ink-4)]">{label}</span>
      <span>{value}</span>
    </span>
  )
}

function DetailLine({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div>
      <p className="vs-note">{label}</p>
      <p className="mt-0.5 text-[14px] leading-relaxed text-[var(--vs-ink-2)]">{value}</p>
    </div>
  )
}
