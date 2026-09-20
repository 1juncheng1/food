'use client'

import type { CreativeBlueprint } from '@/lib/creative/blueprint'
import type { FrozenPlan } from '@/lib/creative/plan'

// ============================================================
// 创作蓝图卡片（纯展示）
// thinking 期完整展示；V1 完成后在结果页以可折叠条形式回看。
// 深色主题，与 /article 结果页现有卡片风格一致。
// 阶段 C：兼容方案超集（content_type / language_style / word_count），有值才渲染。
// ============================================================

type BlueprintLike = CreativeBlueprint & {
  content_type?: string
  language_style?: { pace?: string; mood?: string; expression?: string }
  word_count?: number
  usage_tag?: string
  problem_understanding?: {
    problem_type?: string
    user_goal?: string
    user_identity?: string
    success_criteria?: string
  }
  market_constraints?: {
    avoid_points: string[]
    target_gaps: string[]
    strategy_action: 'reference' | 'upgrade' | 'avoid'
    strategy_reason: string
  }
}

/** 旧 10 字段行配置（顺序即展示顺序） */
const FIELDS: Array<{ key: keyof CreativeBlueprint; label: string; accent?: boolean }> = [
  { key: 'title_direction', label: '标题方向', accent: true },
  { key: 'positioning', label: '主题定位' },
  { key: 'target_audience', label: '目标观众' },
  { key: 'persona_hint', label: '创作视角' },
  { key: 'emotion_curve', label: '情绪曲线' },
  { key: 'opening_hook', label: '开头 Hook' },
  { key: 'core_conflict', label: '核心冲突' },
  { key: 'ending', label: '结尾升华' },
  { key: 'strategy', label: '创作策略' },
]

export function BlueprintCard({ bp }: { bp: BlueprintLike }) {
  const isPlan = !!(bp as FrozenPlan).content_type || !!(bp as FrozenPlan).language_style || !!(bp as FrozenPlan).word_count
  return (
    <div className="bg-zinc-900/60 border border-indigo-500/20 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-base">🧭</span>
        <h2 className="text-sm font-semibold text-white">{isPlan ? '创作方案' : '创作蓝图'}</h2>
        <span className="text-[10px] text-indigo-300 bg-indigo-500/15 px-1.5 py-0.5 rounded">
          {isPlan ? '已确认方案' : 'AI 构思'}
        </span>
      </div>

      <div className="space-y-3.5">
        {/* 方案新字段：内容类型 / 语言风格 / 字数（有值才渲染，且排在前面让用户一眼看到核心约束） */}
        {bp.content_type && (
          <div>
            <p className="text-xs text-zinc-500 mb-1">内容类型</p>
            <p className="text-sm text-emerald-200 font-medium">{bp.content_type}</p>
          </div>
        )}
        {bp.language_style && (() => {
          const ls = [bp.language_style.pace, bp.language_style.mood, bp.language_style.expression]
            .filter(Boolean)
            .join(' · ')
          if (!ls) return null
          return (
            <div>
              <p className="text-xs text-zinc-500 mb-1">语言风格</p>
              <p className="text-sm text-zinc-300">{ls}</p>
            </div>
          )
        })()}
        {bp.word_count && (
          <div>
            <p className="text-xs text-zinc-500 mb-1">目标字数</p>
            <p className="text-sm text-zinc-300">{bp.word_count} 字</p>
          </div>
        )}
        {/* 阶段 3：AI 推断的素材用途标签 */}
        {bp.usage_tag && (
          <div>
            <p className="text-xs text-zinc-500 mb-1">素材用途</p>
            <p className="text-sm text-emerald-300">{bp.usage_tag}</p>
          </div>
        )}
        {/* 阶段 3：问题理解（有值才渲染） */}
        {bp.problem_understanding?.problem_type && (
          <div className="rounded-lg border border-zinc-800/60 bg-zinc-950/50 p-3">
            <p className="text-xs text-zinc-500 mb-2">问题理解</p>
            <div className="space-y-1.5">
              {bp.problem_understanding.problem_type && (
                <p className="text-xs text-zinc-300">
                  <span className="text-zinc-500">类型：</span>{bp.problem_understanding.problem_type}
                </p>
              )}
              {bp.problem_understanding.user_goal && (
                <p className="text-xs text-zinc-300">
                  <span className="text-zinc-500">用户目标：</span>{bp.problem_understanding.user_goal}
                </p>
              )}
              {bp.problem_understanding.user_identity && (
                <p className="text-xs text-zinc-300">
                  <span className="text-zinc-500">用户身份：</span>{bp.problem_understanding.user_identity}
                </p>
              )}
              {bp.problem_understanding.success_criteria && (
                <p className="text-xs text-zinc-300">
                  <span className="text-zinc-500">成功标准：</span>{bp.problem_understanding.success_criteria}
                </p>
              )}
            </div>
          </div>
        )}

        {FIELDS.map(({ key, label, accent }) => {
          const value = bp[key]
          if (!value) return null
          return (
            <div key={key}>
              <p className="text-xs text-zinc-500 mb-1">{label}</p>
              <p
                className={`text-sm leading-relaxed ${
                  accent ? 'text-indigo-200 font-medium' : 'text-zinc-300'
                }`}
              >
                {value}
              </p>
            </div>
          )
        })}

        {/* 叙事结构：步骤列表（Array.isArray 守卫：localStorage 数据损坏时不整页崩溃） */}
        {Array.isArray(bp.structure) && bp.structure.length > 0 && (
          <div>
            <p className="text-xs text-zinc-500 mb-1.5">叙事结构</p>
            <ol className="space-y-1.5">
              {bp.structure.map((step, i) => (
                <li key={i} className="flex gap-2.5 text-sm text-zinc-300 leading-relaxed">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-indigo-500/15 text-indigo-300 text-xs flex items-center justify-center mt-0.5">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* 市场硬约束：方案确认时 AI 提炼的"避开同质化 / 瞄准内容缺口"，正文生成已按此执行，展示给用户增强信任 */}
        {bp.market_constraints && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <p className="text-xs text-amber-300/80 mb-2">🎯 市场约束（正文已按此规避/覆盖）</p>
            <div className="space-y-1.5">
              {Array.isArray(bp.market_constraints.avoid_points) &&
                bp.market_constraints.avoid_points.map((p, i) => (
                  <p key={`a${i}`} className="text-xs text-zinc-300 leading-relaxed">
                    <span className="text-amber-400/90">避开：</span>{p}
                  </p>
                ))}
              {Array.isArray(bp.market_constraints.target_gaps) &&
                bp.market_constraints.target_gaps.map((g, i) => (
                  <p key={`g${i}`} className="text-xs text-zinc-300 leading-relaxed">
                    <span className="text-emerald-400/90">瞄准：</span>{g}
                  </p>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
