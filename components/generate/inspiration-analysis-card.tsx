'use client'

// ============================================================
// InspirationAnalysisCard —— 灵感分析卡（insight 态展示）
//
// 展示 AI 对模糊灵感的分析结果：
//   1. 价值评估 6 维度 + 综合分
//   2. 优化建议（最大问题 / 缺什么 / 如何提升）
//   3. 召回素材预览（仅登录用户）
//   4. 市场机会分析（二级深挖动作，显式触发；含"AI 估算"免责标注）
//   5. 两个 CTA：
//      - "基于这个灵感开始创作"（携带 context 走现有 plan）
//      - "换个灵感再分析"
// ============================================================

import { useState } from 'react'
import type {
  InspirationAnalysis,
  ValueAssessment,
  OptimizationSuggestions,
  OpportunityQuadrant,
} from '@/lib/creative/inspirationAnalyzer'
import { getOpportunityQuadrant } from '@/lib/creative/inspirationAnalyzer'
import type { MarketReport, MarketStrategyAction } from '@/lib/creative/marketAnalyzer'

interface RecalledMaterialPreview {
  id: string
  preview: string
  similarity: number
}

interface Props {
  analysis: InspirationAnalysis
  recalledMaterials: RecalledMaterialPreview[]
  /** 市场机会分析结果（二级深挖动作产出，可空） */
  marketReport: MarketReport | null
  marketLoading: boolean
  onMarketAnalysis: () => void
  onStartCreation: () => void
  onReset: () => void
  loading?: boolean
}

/** 综合分颜色：高分绿、中分黄、低分红——视觉上即刻反馈"值不值得做" */
function scoreColor(score: number): string {
  if (score >= 7) return 'text-emerald-300'
  if (score >= 5) return 'text-amber-300'
  return 'text-rose-300'
}
function scoreBg(score: number): string {
  if (score >= 7) return 'bg-emerald-500/15 border-emerald-500/30'
  if (score >= 5) return 'bg-amber-500/15 border-amber-500/30'
  return 'bg-rose-500/15 border-rose-500/30'
}

/** 机会矩阵配置：4 象限的视觉与文案 */
const QUADRANT_META: Record<OpportunityQuadrant, {
  label: string
  emoji: string
  className: string
  hint: string
}> = {
  blue_ocean: {
    label: '蓝海机会',
    emoji: '🟢',
    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
    hint: '高价值 × 低竞争：值得做，抓住时机',
  },
  red_ocean: {
    label: '红海需差异化',
    emoji: '🟡',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
    hint: '高价值 × 高竞争：值得做，但必须差异化切入',
  },
  needs_refinement: {
    label: '选题待优化',
    emoji: '🟠',
    className: 'border-orange-500/40 bg-orange-500/10 text-orange-200',
    hint: '低价值 × 低竞争：方向可行但需补充信息或改变角度',
  },
  not_recommended: {
    label: '不建议做',
    emoji: '🔴',
    className: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
    hint: '低价值 × 高竞争：建议换方向',
  },
}

function ValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="shrink-0 text-zinc-500 min-w-[64px]">{label}</span>
      <span className="text-zinc-200 leading-relaxed">{value}</span>
    </div>
  )
}

/** 推荐策略徽章配置 */
const STRATEGY_META: Record<MarketStrategyAction, { label: string; className: string }> = {
  reference: {
    label: '建议参考',
    className: 'bg-sky-500/15 border-sky-500/40 text-sky-200',
  },
  upgrade: {
    label: '建议升级',
    className: 'bg-violet-500/15 border-violet-500/40 text-violet-200',
  },
  avoid: {
    label: '建议避开',
    className: 'bg-rose-500/15 border-rose-500/40 text-rose-200',
  },
}

/** 市场报告区块（含免责标注 + 折叠） */
function MarketReportBlock({
  report,
  onStartCreation,
}: {
  report: MarketReport
  onStartCreation: () => void
}) {
  const [open, setOpen] = useState(true)
  const sm = STRATEGY_META[report.strategy.action]

  return (
    <div className="mt-4 rounded-xl border border-sky-500/20 bg-sky-500/5 p-4">
      {/* 头部：标题 + 数据来源免责标注（按 data_source_mode 如实标注） + 折叠 */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-sky-200">市场机会分析</h3>
        <div className="flex items-center gap-2">
          {report.data_source_mode === 'web_search' ? (
            <span
              className="px-2 py-0.5 rounded-full text-[10px] text-sky-300 bg-sky-500/10 border border-sky-500/30 whitespace-nowrap"
              title="基于实时网页/新闻搜索结果提取分析；数据为公开网页信号，不含平台内部互动数据"
            >
              基于实时搜索
            </span>
          ) : (
            <span
              className="px-2 py-0.5 rounded-full text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 whitespace-nowrap"
              title="当前为 AI 基于训练知识的模式级估算，非实时平台数据"
            >
              AI 估算 · 非实时数据
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition"
          >
            {open ? '收起' : '展开'}
          </button>
        </div>
      </div>

      {open && (
        <>
          {/* 市场热度 */}
          <div className="mt-3 flex items-center gap-3">
            <span className="text-xs text-zinc-500 shrink-0">市场热度</span>
            <div className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-500 to-violet-500"
                style={{ width: `${report.heat_level * 10}%` }}
              />
            </div>
            <span className="text-sm font-bold text-sky-300 shrink-0">{report.heat_level}/10</span>
          </div>
          <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">{report.market_heat}</p>

          {/* 热门内容方向（模式级） */}
          <div className="mt-3.5">
            <p className="text-xs text-zinc-500 mb-1.5">热门内容方向</p>
            <ul className="space-y-1.5">
              {report.hot_directions.map((d, i) => (
                <li key={i} className="text-xs text-zinc-300 flex items-start gap-2">
                  <span className="shrink-0 text-sky-400/70">·</span>
                  <span>
                    <span className="text-zinc-100">{d.pattern}</span>
                    <span className="text-zinc-500"> —— {d.why}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-3.5 space-y-2">
            <ValueRow label="关注原因" value={report.audience_motivation} />
            <ValueRow label="主流表达" value={report.mainstream_expression} />
          </div>

          {/* 同质化 vs 内容缺口：核心决策信息并排展示 */}
          <div className="mt-3.5 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3">
              <p className="text-xs text-rose-300 font-medium mb-1.5">同质化重复点（避开）</p>
              <ul className="space-y-1">
                {report.homogenization_points.map((x, i) => (
                  <li key={i} className="text-xs text-zinc-400 flex items-start gap-1.5">
                    <span className="shrink-0 text-rose-400/70">·</span>
                    <span>{x}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <p className="text-xs text-emerald-300 font-medium mb-1.5">内容缺口（机会）</p>
              <ul className="space-y-1">
                {report.content_gaps.map((x, i) => (
                  <li key={i} className="text-xs text-zinc-300 flex items-start gap-1.5">
                    <span className="shrink-0 text-emerald-400/70">·</span>
                    <span>{x}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* 竞争风险 + 推荐策略 */}
          {report.competition_risks.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-zinc-500 mb-1">竞争风险</p>
              <ul className="space-y-1">
                {report.competition_risks.map((x, i) => (
                  <li key={i} className="text-xs text-zinc-400 flex items-start gap-1.5">
                    <span className="shrink-0 text-zinc-600">·</span>
                    <span>{x}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className={`mt-3 rounded-lg border p-3 ${sm.className}`}>
            <p className="text-xs font-semibold">{sm.label}</p>
            <p className="text-xs opacity-80 mt-0.5">{report.strategy.reason}</p>
          </div>

          <p className="text-[11px] text-zinc-600 mt-3">
            开始创作后，AI 将优先瞄准"内容缺口"设计方向，并避开同质化重复点
          </p>
          <button
            type="button"
            onClick={onStartCreation}
            className="mt-2 w-full py-2.5 rounded-xl text-xs text-sky-200 border border-sky-500/30 hover:border-sky-500/50 hover:bg-sky-500/10 transition"
          >
            基于市场缺口开始创作 →
          </button>
        </>
      )}
    </div>
  )
}

export function InspirationAnalysisCard({
  analysis,
  recalledMaterials,
  marketReport,
  marketLoading,
  onMarketAnalysis,
  onStartCreation,
  onReset,
  loading,
}: Props) {
  const v: ValueAssessment = analysis.value_assessment
  const o: OptimizationSuggestions = analysis.optimization_suggestions
  const isLow = v.overall_score < 5
  const quadrant = getOpportunityQuadrant(v.overall_score, v.competition_level)
  const qm = QUADRANT_META[quadrant]

  return (
    <div className="gen-insight anim-rise">
      {/* ── 头部：综合分 + 竞争度 + 灵感类型 ── */}
      <div className="gen-insight-head">
        <div>
          <span className="text-xs text-zinc-500">灵感分析</span>
          <h2 className="text-lg font-medium text-white mt-1">
            综合评分
            <span className={`ml-2 text-2xl font-bold ${scoreColor(v.overall_score)}`}>
              {v.overall_score}
            </span>
            <span className="text-sm text-zinc-600">/10</span>
            <span className="mx-3 text-zinc-700">·</span>
            竞争度
            <span className={`ml-2 text-2xl font-bold ${
              v.competition_level >= 7 ? 'text-rose-300'
              : v.competition_level >= 5 ? 'text-amber-300'
              : 'text-emerald-300'
            }`}>
              {v.competition_level}
            </span>
            <span className="text-sm text-zinc-600">/10</span>
          </h2>
        </div>
        <span
          className="px-3 py-1 rounded-full text-xs text-zinc-400 bg-zinc-800/60 border border-zinc-700"
        >
          {analysis.input_type}
        </span>
      </div>

      {/* ── 机会矩阵徽章：overall_score × competition_level 即时判断 ── */}
      <div className={`mt-4 rounded-xl border p-4 ${qm.className}`}>
        <div className="flex items-center gap-2">
          <span className="text-base">{qm.emoji}</span>
          <span className="text-sm font-semibold">{qm.label}</span>
        </div>
        <p className="text-xs opacity-80 mt-1">{qm.hint}</p>
      </div>

      {/* ── 低分提示条 ── */}
      {isLow && v.issues.length > 0 && (
        <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
          <p className="text-xs text-rose-300 font-medium mb-2">
            这个灵感质量偏低，直接做可能会陷入同质化竞争
          </p>
          <ul className="space-y-1">
            {v.issues.map((issue, i) => (
              <li key={i} className="text-xs text-rose-200/80 flex items-start gap-2">
                <span className="shrink-0 text-rose-400">·</span>
                <span>{issue}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── 价值评估 6 维 ── */}
      <div className={`mt-4 rounded-xl border p-4 ${scoreBg(v.overall_score)}`}>
        <h3 className="text-sm font-medium text-zinc-200 mb-3">价值评估</h3>
        <div className="space-y-2.5">
          <ValueRow label="是什么" value={v.what_it_is} />
          <ValueRow label="核心主题" value={v.core_theme} />
          <ValueRow label="创作价值" value={v.creation_value} />
          <ValueRow label="新鲜度" value={v.freshness} />
          <ValueRow label="讨论度" value={v.discussability} />
          <ValueRow label="差异化" value={v.differentiation} />
        </div>
      </div>

      {/* ── 优化建议 ── */}
      <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <h3 className="text-sm font-medium text-zinc-200 mb-3">优化建议</h3>
        <ValueRow label="最大问题" value={o.main_problem} />
        {o.missing_info.length > 0 && (
          <div className="mt-2.5">
            <p className="text-xs text-zinc-500 mb-1">缺少的信息</p>
            <ul className="space-y-1">
              {o.missing_info.map((info, i) => (
                <li key={i} className="text-sm text-zinc-300 flex items-start gap-2">
                  <span className="shrink-0 text-zinc-600">·</span>
                  <span>{info}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {o.missing_viewpoints.length > 0 && (
          <div className="mt-2.5">
            <p className="text-xs text-zinc-500 mb-1">缺少的观点</p>
            <ul className="space-y-1">
              {o.missing_viewpoints.map((vp, i) => (
                <li key={i} className="text-sm text-zinc-300 flex items-start gap-2">
                  <span className="shrink-0 text-zinc-600">·</span>
                  <span>{vp}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-3 pt-3 border-t border-zinc-800">
          <p className="text-xs text-zinc-500 mb-1">如何提升</p>
          <p className="text-sm text-zinc-200 leading-relaxed">{o.improvement_direction}</p>
        </div>
      </div>

      {/* ── 召回素材 ── */}
      {recalledMaterials.length > 0 && (
        <div className="mt-4 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4">
          <h3 className="text-sm font-medium text-indigo-200 mb-2">相关素材召回</h3>
          <p className="text-xs text-zinc-500 mb-3">
            从你的素材库找到 {recalledMaterials.length} 条相关素材，创作时会自动参考
          </p>
          <ul className="space-y-2">
            {recalledMaterials.map((m) => (
              <li key={m.id} className="text-xs text-zinc-400 flex items-start gap-2">
                <span className="shrink-0 text-indigo-400/70 min-w-[36px]">
                  {m.similarity}%
                </span>
                <span className="line-clamp-2">{m.preview}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── 市场机会分析：二级深挖动作（显式触发，不默认执行）── */}
      {marketReport ? (
        <MarketReportBlock report={marketReport} onStartCreation={onStartCreation} />
      ) : marketLoading ? (
        <div className="mt-4 rounded-xl border border-sky-500/20 bg-sky-500/5 p-4">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 rounded-full border-2 border-sky-500/30 border-t-sky-400 animate-spin shrink-0" />
            <p className="text-xs text-sky-200">正在分析市场格局、同质化与内容缺口…</p>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={onMarketAnalysis}
          className="mt-4 w-full py-2.5 rounded-xl text-xs text-zinc-400 border border-zinc-800 hover:border-sky-500/40 hover:text-sky-200 hover:bg-sky-500/5 transition"
        >
          🔍 深挖市场机会：看看同类内容都在做什么、哪里还有空白
        </button>
      )}

      {/* ── CTA ── */}
      <div className="mt-6 flex flex-col gap-2">
        <button
          type="button"
          onClick={onStartCreation}
          disabled={loading}
          className="gen-submit btn-shine w-full py-4 rounded-2xl font-semibold text-base text-white transition disabled:opacity-60"
        >
          {loading ? '正在进入创作…' : '基于这个灵感开始创作 →'}
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={loading}
          className="w-full py-2.5 rounded-xl text-sm text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700 transition disabled:opacity-50"
        >
          换个灵感再分析
        </button>
      </div>

      <p className="text-[11px] text-zinc-600 mt-3 text-center">
        点击后将携带本次分析进入创作方案阶段；AI 会延续分析结论设计 3 个差异化方向
      </p>
    </div>
  )
}
