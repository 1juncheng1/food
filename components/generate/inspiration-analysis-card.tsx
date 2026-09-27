'use client'

// ============================================================
// InspirationAnalysisCard —— 灵感分析卡（insight 态展示）
//
// 展示 AI 对模糊灵感的分析结果：
//   1. 价值评估 6 维度 + 综合分
//   2. 优化建议（最大问题 / 缺什么 / 如何提升）
//   3. 召回素材预览（仅登录用户）
//   4. 市场机会分析（二级深挖动作，显式触发；含"AI 估算"免责标注）
//   5. 三个 CTA：
//      - "基于这个灵感开始创作"（用灵感阶段最优解 optimized_topic 当创作主题）
//      - "基于市场缺口开始创作"（用市场阶段最优解 recommended_topic 当创作主题）
//      - "换个灵感再分析"
//
// 【阶段最优解】原则：两个创作入口各自携带本阶段的最优解进入 plan，
// 而不是把用户最初输入的原始灵感当作创作主题。
// ============================================================

import { useState } from 'react'
import type {
  InspirationAnalysis,
  ValueAssessment,
  OptimizationSuggestions,
  OpportunityQuadrant,
} from '@/lib/creative/inspirationAnalyzer'
import { getOpportunityQuadrant } from '@/lib/creative/opportunity'
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
  /** 灵感阶段入口：用 value_assessment + optimization 体系下的最优解开始创作 */
  onStartCreation: () => void
  /** 市场阶段入口：用市场缺口体系下的最优解开始创作 */
  onStartCreationFromMarket: () => void
  onReset: () => void
  loading?: boolean
}

/**
 * 机会矩阵配置：只留文案 + 一档语义（落实 / 部分 / 不符）。
 * 四象限不再各配一种颜色 —— 价值与竞争两个分数已经在头部用等宽数字说清楚了，
 * 这里只需要给结论，颜色复用设计系统既有的三档。
 */
const QUADRANT_META: Record<
  OpportunityQuadrant,
  { label: string; verdict?: 'partial' | 'off'; hint: string }
> = {
  blue_ocean: {
    label: '蓝海机会',
    hint: '高价值 × 低竞争：值得做，抓住时机',
  },
  red_ocean: {
    label: '红海需差异化',
    verdict: 'partial',
    hint: '高价值 × 高竞争：值得做，但必须差异化切入',
  },
  needs_refinement: {
    label: '选题待优化',
    verdict: 'partial',
    hint: '低价值 × 低竞争：方向可行但需补充信息或改变角度',
  },
  not_recommended: {
    label: '不建议做',
    verdict: 'off',
    hint: '低价值 × 高竞争：建议换方向',
  },
}

function ValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="vs-note shrink-0 min-w-[64px]">{label}</span>
      <span className="text-[14px] leading-relaxed text-[var(--vs-ink-2)]">{value}</span>
    </div>
  )
}

/** 推荐策略徽章：三个动作里只有「避开」是负面结论，其余中性 */
const STRATEGY_META: Record<MarketStrategyAction, { label: string; verdict?: 'off' }> = {
  reference: { label: '建议参考' },
  upgrade: { label: '建议升级' },
  avoid: { label: '建议避开', verdict: 'off' },
}

/**
 * 「本阶段最优解」区块：把该阶段 AI 结论里最值得创作的那一句显式展示出来，
 * 让用户知道自己点开始创作后，AI 到底会写什么。
 */
function OptimalTopicBlock({ eyebrow, topic }: { eyebrow: string; topic: string }) {
  return (
    <div className="vs-sec mt-4">
      <p className="vs-mark">{eyebrow}</p>
      <p className="mt-2 text-[15px] leading-relaxed text-[var(--vs-ink)]">{topic}</p>
      <p className="vs-note mt-2">
        开始创作后，这就是本次的创作主题（原始灵感仅作为分析依据保留）
      </p>
    </div>
  )
}

/** 市场报告区块（含免责标注 + 折叠） */
function MarketReportBlock({
  report,
  onStartCreationFromMarket,
}: {
  report: MarketReport
  onStartCreationFromMarket: () => void
}) {
  const [open, setOpen] = useState(true)
  const sm = STRATEGY_META[report.strategy.action]

  return (
    <div className="vs-sec mt-4">
      {/* 头部：标题 + 数据来源免责标注（按 data_source_mode 如实标注） + 折叠 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="vs-mark">市场机会分析</h3>
        <div className="flex flex-wrap items-center gap-2">
          {report.data_source_mode === 'web_search' ? (
            <span
              className="vs-verdict whitespace-nowrap"
              title="基于实时网页/新闻搜索结果提取分析；数据为公开网页信号，不含平台内部互动数据"
            >
              基于实时搜索
            </span>
          ) : (
            <span
              className="vs-verdict whitespace-nowrap"
              data-verdict="partial"
              title="当前为 AI 基于训练知识的模式级估算，非实时平台数据"
            >
              AI 估算 · 非实时数据
            </span>
          )}
          <button type="button" onClick={() => setOpen((v) => !v)} className="vs-link">
            {open ? '收起' : '展开'}
          </button>
        </div>
      </div>

      {open && (
        <>
          {/* 市场热度 */}
          <div className="mt-3 flex items-center gap-3">
            <span className="vs-note shrink-0">市场热度</span>
            <div className="vs-dna-track flex-1">
              <span className="vs-dna-fill" style={{ width: `${report.heat_level * 10}%` }} />
            </div>
            <span className="vs-num shrink-0 text-[var(--vs-ink)]">{report.heat_level}/10</span>
          </div>
          <p className="vs-note mt-1.5 leading-relaxed">{report.market_heat}</p>

          {/* 热门内容方向（模式级） */}
          <div className="mt-4">
            <p className="vs-note mb-1.5">热门内容方向</p>
            <ul className="space-y-1.5">
              {report.hot_directions.map((d, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--vs-ink-3)]"
                >
                  <span className="shrink-0 text-[var(--vs-ink-5)]">·</span>
                  <span>
                    <span className="text-[var(--vs-ink)]">{d.pattern}</span>
                    <span className="text-[var(--vs-ink-4)]"> —— {d.why}</span>
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
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
            <div className="border-t border-[var(--vs-line)] pt-3">
              <p className="vs-note mb-1.5">同质化重复点（避开）</p>
              <ul className="space-y-1">
                {report.homogenization_points.map((x, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--vs-ink-3)]"
                  >
                    <span className="shrink-0 text-[var(--vs-ink-5)]">·</span>
                    <span>{x}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="border-t border-[var(--vs-line)] pt-3">
              <p className="vs-note mb-1.5">内容缺口（机会）</p>
              <ul className="space-y-1">
                {report.content_gaps.map((x, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--vs-ink-2)]"
                  >
                    <span className="shrink-0 text-[var(--vs-ink-5)]">·</span>
                    <span>{x}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* 竞争风险 + 推荐策略 */}
          {report.competition_risks.length > 0 && (
            <div className="mt-4">
              <p className="vs-note mb-1">竞争风险</p>
              <ul className="space-y-1">
                {report.competition_risks.map((x, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--vs-ink-3)]"
                  >
                    <span className="shrink-0 text-[var(--vs-ink-5)]">·</span>
                    <span>{x}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-4">
            <span className="vs-verdict" data-verdict={sm.verdict}>
              {sm.label}
            </span>
            <p className="vs-note mt-1.5 leading-relaxed">{report.strategy.reason}</p>
          </div>

          {report.recommended_topic ? (
            <>
              <OptimalTopicBlock
                eyebrow="市场阶段最优解：最能打的内容缺口"
                topic={report.recommended_topic}
              />
              <p className="vs-note mt-2">
                开始创作后，AI 将以这个题为创作主题，瞄准“内容缺口”设计方向、避开同质化重复点
              </p>
            </>
          ) : (
            <p className="vs-note mt-3">
              开始创作后，AI 将优先瞄准“内容缺口”设计方向，并避开同质化重复点
            </p>
          )}
          <button
            type="button"
            onClick={onStartCreationFromMarket}
            className="vs-btn vs-btn-ghost vs-btn-sm mt-3 w-full"
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
  onStartCreationFromMarket,
  onReset,
  loading,
}: Props) {
  const v: ValueAssessment = analysis.value_assessment
  const o: OptimizationSuggestions = analysis.optimization_suggestions
  const isLow = v.overall_score < 5
  const quadrant = getOpportunityQuadrant(v.overall_score, v.competition_level)
  const qm = QUADRANT_META[quadrant]

  return (
    <div className="anim-rise">
      {/* ── 头部：综合分 + 竞争度 + 灵感类型 ── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="vs-mark">灵感分析</p>
          <h2 className="vs-h3 mt-2 flex flex-wrap items-baseline gap-x-2">
            综合评分
            <span className="vs-num text-[26px] font-semibold">{v.overall_score}</span>
            <span className="vs-note">/10</span>
            <span className="mx-1 text-[var(--vs-ink-5)]">·</span>
            竞争度
            <span className="vs-num text-[26px] font-semibold">{v.competition_level}</span>
            <span className="vs-note">/10</span>
          </h2>
        </div>
        <span className="vs-verdict shrink-0">{analysis.input_type}</span>
      </div>

      {/* ── 机会矩阵徽章：overall_score × competition_level 即时判断 ── */}
      <div className="vs-sec mt-4">
        <span className="vs-verdict" data-verdict={qm.verdict}>
          {qm.label}
        </span>
        <p className="vs-note mt-2">{qm.hint}</p>
      </div>

      {/* ── 低分提示条 ── */}
      {isLow && v.issues.length > 0 && (
        <div className="vs-warn mt-4">
          <p className="vs-note vs-note-warn">
            这个灵感质量偏低，直接做可能会陷入同质化竞争
          </p>
          <ul className="mt-1.5 space-y-1">
            {v.issues.map((issue, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--vs-ink-3)]"
              >
                <span className="shrink-0 text-[var(--vs-ink-5)]">·</span>
                <span>{issue}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── 价值评估 6 维 ── */}
      <div className="vs-sec mt-4">
        <h3 className="vs-mark">价值评估</h3>
        <div className="mt-3 space-y-2.5">
          <ValueRow label="是什么" value={v.what_it_is} />
          <ValueRow label="核心主题" value={v.core_theme} />
          <ValueRow label="创作价值" value={v.creation_value} />
          <ValueRow label="新鲜度" value={v.freshness} />
          <ValueRow label="讨论度" value={v.discussability} />
          <ValueRow label="差异化" value={v.differentiation} />
        </div>
      </div>

      {/* ── 优化建议 ── */}
      <div className="vs-sec mt-4">
        <h3 className="vs-mark">优化建议</h3>
        <div className="mt-3">
          <ValueRow label="最大问题" value={o.main_problem} />
        </div>
        {o.missing_info.length > 0 && (
          <div className="mt-3">
            <p className="vs-note mb-1">缺少的信息</p>
            <ul className="space-y-1">
              {o.missing_info.map((info, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--vs-ink-3)]"
                >
                  <span className="shrink-0 text-[var(--vs-ink-5)]">·</span>
                  <span>{info}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {o.missing_viewpoints.length > 0 && (
          <div className="mt-3">
            <p className="vs-note mb-1">缺少的观点</p>
            <ul className="space-y-1">
              {o.missing_viewpoints.map((vp, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--vs-ink-3)]"
                >
                  <span className="shrink-0 text-[var(--vs-ink-5)]">·</span>
                  <span>{vp}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-4 pt-3 border-t border-[var(--vs-line)]">
          <p className="vs-note mb-1">如何提升</p>
          <p className="text-[14px] leading-relaxed text-[var(--vs-ink-2)]">
            {o.improvement_direction}
          </p>
        </div>
      </div>

      {/* ── 召回素材 ── */}
      {recalledMaterials.length > 0 && (
        <div className="vs-sec mt-4">
          <h3 className="vs-mark">相关素材召回</h3>
          <p className="vs-note mt-2">
            从你的素材库找到 <span className="vs-num">{recalledMaterials.length}</span>{' '}
            条相关素材，创作时会自动参考
          </p>
          <ul className="mt-3 space-y-2">
            {recalledMaterials.map((m) => (
              <li
                key={m.id}
                className="flex items-start gap-3 text-[13px] leading-relaxed text-[var(--vs-ink-3)]"
              >
                <span className="vs-num shrink-0 min-w-[36px] text-[var(--vs-ink-4)]">
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
        <MarketReportBlock
          report={marketReport}
          onStartCreationFromMarket={onStartCreationFromMarket}
        />
      ) : marketLoading ? (
        <div className="mt-4 flex items-center gap-3">
          <span className="vs-ai-dots" aria-hidden="true">
            <i className="vs-ai-dot" />
            <i className="vs-ai-dot" />
            <i className="vs-ai-dot" />
          </span>
          <p className="vs-note">正在分析市场格局、同质化与内容缺口</p>
        </div>
      ) : (
        <button
          type="button"
          onClick={onMarketAnalysis}
          className="vs-btn vs-btn-ghost vs-btn-sm mt-4 w-full"
        >
          深挖市场机会：看看同类内容都在做什么、哪里还有空白
        </button>
      )}

      {/* ── 灵感阶段最优解：点击下面的按钮即以此为创作主题 ── */}
      {o.optimized_topic && (
        <OptimalTopicBlock
          eyebrow="灵感阶段最优解：按优化建议改写后的创作主题"
          topic={o.optimized_topic}
        />
      )}

      {/* ── CTA ── */}
      <div className="mt-6 flex flex-col gap-3">
        <button
          type="button"
          onClick={onStartCreation}
          disabled={loading}
          className="vs-btn vs-btn-primary w-full disabled:opacity-60"
        >
          {loading
            ? '正在进入创作…'
            : o.optimized_topic
              ? '用这个最优解开始创作 →'
              : '基于这个灵感开始创作 →'}
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={loading}
          className="vs-btn vs-btn-ghost w-full disabled:opacity-50"
        >
          换个灵感再分析
        </button>
      </div>

      <p className="vs-note mt-3 text-center">
        点击后将携带本次分析进入创作方案阶段；创作主题为该阶段最优解，AI 会围绕它设计 3 个差异化方向
      </p>
    </div>
  )
}
