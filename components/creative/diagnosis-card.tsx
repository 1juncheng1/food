// AI 作品诊断卡：五维定性信号（不显示精确分数）+ 优势 / 问题 / 建议。
// 方向迭代入口已移至 WorkFeedbackPanel。纯展示组件：数据获取与重试由 article 页控制。

'use client'

import {
  DIMENSION_META,
  LEVEL_LABELS,
  type CreativeDiagnosis,
  type DimensionKey,
} from '@/lib/creative/diagnosis'

interface DiagnosisCardProps {
  diagnosis?: CreativeDiagnosis | null
  loading?: boolean // 首次诊断进行中
  error?: string | null
  onRetry?: () => void // 失败后重试
  onRefresh?: () => void // 已有诊断时强制重新诊断
  refreshing?: boolean
  // 项目已定稿：方向卡不可点
  actionsDisabled?: boolean
  // 与更早版本的五维对比（最新版视图传入上一版 levels）
  compare?: { label: string; levels: Record<DimensionKey, number> } | null
}

/** 等级对应的文字颜色（信号条统一 indigo，文字颜色区分强弱） */
function levelColor(level: number): string {
  if (level >= 5) return 'text-emerald-400'
  if (level === 4) return 'text-indigo-300'
  if (level === 3) return 'text-zinc-300'
  if (level === 2) return 'text-amber-400'
  return 'text-red-400'
}

function LoadingState() {
  return (
    <div className="bg-zinc-900/60 border border-indigo-500/20 rounded-xl px-5 py-5">
      <div className="flex items-center gap-2 text-sm text-zinc-300">
        <span>🧪</span>
        <span className="font-medium">AI 作品诊断</span>
        <span className="flex gap-1 ml-1">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce [animation-delay:-0.3s]" />
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce [animation-delay:-0.15s]" />
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" />
        </span>
      </div>
      <p className="text-xs text-zinc-500 mt-3">
        AI 正在通读全文，从开头、结构、情感、风格与传播潜力五个维度体检…
      </p>
      <div className="space-y-2.5 mt-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-3 rounded bg-zinc-800/70 animate-pulse" style={{ width: `${85 - i * 9}%` }} />
        ))}
      </div>
    </div>
  )
}

export function DiagnosisCard({
  diagnosis,
  loading = false,
  error = null,
  onRetry,
  onRefresh,
  refreshing = false,
  actionsDisabled = false,
  compare = null,
}: DiagnosisCardProps) {

  if (loading) return <LoadingState />

  if (error || !diagnosis) {
    return (
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-5 py-5 flex items-center justify-between gap-4">
        <p className="text-xs text-zinc-500">
          {error ? `诊断未完成：${error}` : '暂无诊断结果'}
        </p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="shrink-0 text-xs bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded-lg transition"
          >
            重试诊断
          </button>
        )}
      </div>
    )
  }

  const lists: Array<{ title: string; emoji: string; color: string; items: string[] }> = [
    { title: '做得好的地方', emoji: '✅', color: 'text-emerald-400', items: diagnosis.strengths },
    { title: '存在的问题', emoji: '⚠️', color: 'text-amber-400', items: diagnosis.problems },
    { title: '可执行的改法', emoji: '🛠️', color: 'text-indigo-300', items: diagnosis.suggestions },
  ]

  return (
    <div className="bg-zinc-900/60 border border-indigo-500/20 rounded-xl overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800/80">
        <div className="flex items-center gap-2">
          <span>🧪</span>
          <span className="text-sm font-semibold text-zinc-200">AI 作品诊断</span>
          {diagnosis.diagnosedAt && (
            <span className="text-[11px] text-zinc-600">
              {new Date(diagnosis.diagnosedAt).toLocaleString('zh-CN', {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
        </div>
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition"
          >
            {refreshing ? '重新诊断中…' : '↻ 重新诊断'}
          </button>
        )}
      </div>

      <div className="px-5 py-5 space-y-6">
        {/* 五维定性信号 */}
        <div className="space-y-3">
          {DIMENSION_META.map((meta) => {
            const dim = diagnosis.dimensions[meta.key]
            const level = dim?.level ?? 3
            const prevLevel = compare?.levels[meta.key]
            const diff =
              typeof prevLevel === 'number' && Number.isFinite(prevLevel)
                ? level - prevLevel
                : 0
            return (
              <div key={meta.key} className="flex items-start gap-3">
                <div className="w-28 shrink-0 pt-0.5">
                  <div className="text-xs font-medium text-zinc-300">
                    {meta.emoji} {meta.label}
                  </div>
                  <div className="text-[10px] text-zinc-600 mt-0.5">{meta.hint}</div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    {/* 5 段定性信号条（非百分制） */}
                    <div className="flex gap-1" aria-label={`${meta.label}：${LEVEL_LABELS[level]}`}>
                      {[1, 2, 3, 4, 5].map((seg) => (
                        <span
                          key={seg}
                          className={`w-5 sm:w-6 h-1.5 rounded-sm ${
                            seg <= level ? 'bg-indigo-500/80' : 'bg-zinc-800'
                          }`}
                        />
                      ))}
                    </div>
                    <span className={`text-[11px] font-medium shrink-0 ${levelColor(level)}`}>
                      {LEVEL_LABELS[level]}
                    </span>
                    {/* 阶段 5：与上一版对比的升降箭头 */}
                    {diff !== 0 && (
                      <span
                        className={`text-[11px] font-medium shrink-0 ${
                          diff > 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}
                        title={`较 ${compare?.label ?? '上一版'}`}
                      >
                        {diff > 0 ? `↑${diff}` : `↓${Math.abs(diff)}`}
                      </span>
                    )}
                    {diff === 0 && compare && (
                      <span className="text-[11px] text-zinc-600 shrink-0" title={`较 ${compare.label}`}>
                        →
                      </span>
                    )}
                  </div>
                  {dim?.comment && (
                    <p className="text-xs text-zinc-500 leading-relaxed mt-1.5">{dim.comment}</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* 优势 / 问题 / 建议 */}
        <div className="grid gap-3 sm:grid-cols-3">
          {lists.map((list) => (
            <div key={list.title} className="bg-zinc-900/80 border border-zinc-800/80 rounded-lg px-4 py-3">
              <div className={`text-xs font-medium ${list.color}`}>
                {list.emoji} {list.title}
              </div>
              {list.items.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {list.items.map((item, i) => (
                    <li key={i} className="text-xs text-zinc-400 leading-relaxed">
                      {item}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-zinc-600 mt-2">—</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
