// ============================================================
// 个人风格学习（Style Learning）—— 仅服务端
// 阶段 5：从用户的显式行为中持续学习"用户满意的创作长什么样"，
//         沉淀为 style_profiles.style_dimensions（五维 0~1 画像），
//         在蓝图生成与正文生成时自动注入 prompt。
//
// 学习信号（不引入任何埋点系统，全部复用既有业务动作）：
//   👍 like        权重 1.0  目标 = 该版本诊断五维水平（用户认可这种水平）
//   👎 dislike     权重 0.5  目标 = 反向（用户不想要这种水平）
//   ✓ 定稿最终作品 权重 2.0  目标 = 该版本诊断五维水平（最强偏好信号）
//   🎯 选方向迭代   权重 0.5  目标维度小幅拉升（用户持续想加强的方向）
// 样本太少（samples < 2）时画像不注入，避免一两次行为造成偏见。
//
// 更新算法：加权增量均值（等价于带权 EMA）
//   dim_new = dim_old + (w / (samples + w)) * (target - dim_old)
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DIMENSION_META,
  type CreativeDiagnosis,
  type DimensionKey,
  type NextActionKey,
} from './diagnosis'

/** style_profiles.style_dimensions 的持久化结构 */
export interface StyleDimensionsState {
  dims: Partial<Record<DimensionKey, number>> // 0~1
  samples: number // 已吸收的加权样本数（允许小数）
  updatedAt: string
}

const STORAGE_KEY = 'style_dimensions'
const MIN_SAMPLES_TO_INJECT = 2

/** 迭代方向 → 该动作表达的"想加强"的维度。custom 是用户自由指令，无固定维度，不参与画像 */
export const DIRECTION_DIMENSION: Partial<Record<NextActionKey, DimensionKey>> = {
  hit: 'virality',
  style: 'style_fit',
  emotion: 'emotion',
  depth: 'structure',
  video: 'opening',
  script: 'structure',
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5
  return Math.max(0.05, Math.min(0.95, v))
}

/** 从 jsonb 安全解析风格画像（结构缺失/损坏时返回空画像） */
export function parseStyleDimensions(raw: unknown): StyleDimensionsState {
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>
    const rawDims =
      typeof o.dims === 'object' && o.dims !== null
        ? (o.dims as Record<string, unknown>)
        : {}
    const dims: StyleDimensionsState['dims'] = {}
    for (const meta of DIMENSION_META) {
      const n = Number(rawDims[meta.key])
      if (Number.isFinite(n)) dims[meta.key] = clamp01(n)
    }
    const samples = Number(o.samples)
    return {
      dims,
      samples: Number.isFinite(samples) && samples >= 0 ? samples : 0,
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
    }
  }
  return { dims: {}, samples: 0, updatedAt: '' }
}

/** 把当前画像应用一组带权目标信号，返回新状态（纯函数，便于推理与测试） */
export function applySignals(
  prev: StyleDimensionsState,
  signals: Array<{ dim: DimensionKey; target: number; weight: number }>
): StyleDimensionsState {
  const dims: StyleDimensionsState['dims'] = { ...prev.dims }
  let samples = prev.samples
  for (const sig of signals) {
    const target = clamp01(sig.target)
    const w = sig.weight > 0 ? sig.weight : 0
    if (w <= 0) continue
    const old = typeof dims[sig.dim] === 'number' ? (dims[sig.dim] as number) : target
    const alpha = w / (samples + w)
    dims[sig.dim] = clamp01(old + alpha * (target - old))
    samples += w
  }
  return { dims, samples, updatedAt: new Date().toISOString() }
}

/**
 * 把画像格式化为注入 LLM 的中文文本；样本不足或无数据时返回空串。
 * 水平描述刻意定性（偏好强/偏弱），不输出小数伪精确。
 */
export function formatStyleDimensions(raw: unknown): string {
  const state = parseStyleDimensions(raw)
  if (state.samples < MIN_SAMPLES_TO_INJECT) return ''
  const parts = DIMENSION_META.map((meta) => {
    const v = state.dims[meta.key]
    if (typeof v !== 'number') return null
    const level =
      v >= 0.75 ? '明显偏好高水准' : v <= 0.35 ? '接受相对平实' : '偏好中等以上'
    return `${meta.label}：${level}（${Math.round(v * 100)}）`
  }).filter((x): x is string => x !== null)
  if (parts.length === 0) return ''
  return `【用户长期风格画像（基于其历史满意作品学习，请主动贴合）】
${parts.join('；')}
说明：分值代表用户在该维度上"满意的成品水平"，不是硬性约束；当本次品类不适合时以品类规律为准。`
}

/**
 * 把一组信号写入 style_profiles.style_dimensions（读-改-写，行不存在则建行）。
 * 任何失败都静默：风格学习是增强项，绝不能阻断反馈/生成/定稿主流程。
 */
async function persistSignals(
  supabase: SupabaseClient,
  userId: string,
  signals: Array<{ dim: DimensionKey; target: number; weight: number }>
): Promise<void> {
  try {
    const { data: row } = await supabase
      .from('style_profiles')
      .select(STORAGE_KEY)
      .eq('user_id', userId)
      .maybeSingle()

    const prev = parseStyleDimensions(
      (row as Record<string, unknown> | null)?.[STORAGE_KEY]
    )
    const next = applySignals(prev, signals)

    // upsert：style_profiles 主键 user_id，其余列均有 default
    const { error } = await supabase
      .from('style_profiles')
      .upsert(
        { user_id: userId, [STORAGE_KEY]: next, updated_at: next.updatedAt },
        { onConflict: 'user_id' }
      )
    if (error) console.error('风格画像写入失败（不影响主流程）:', error)
  } catch (e) {
    console.error('风格画像更新异常（不影响主流程）:', e)
  }
}

function dimTargetsFromAnalysis(
  analysis: CreativeDiagnosis,
  reverse: boolean
): Array<{ dim: DimensionKey; target: number; weight: number }> {
  return DIMENSION_META.map((meta) => {
    const level = analysis.dimensions[meta.key]?.level ?? 3
    const target = reverse ? 1 - level / 5 : level / 5
    return { dim: meta.key, target, weight: 0 } // weight 由调用方按信号类型给
  })
}

/** 版本级信号：like / dislike / 定稿（analysis 缺失时无法学习，静默跳过） */
export function recordVersionSignal(
  supabase: SupabaseClient,
  userId: string,
  kind: 'like' | 'dislike' | 'finalize',
  analysis: CreativeDiagnosis | null | undefined
): void {
  if (!analysis) return
  const weight = kind === 'finalize' ? 2 : kind === 'like' ? 1 : 0.5
  const signals = dimTargetsFromAnalysis(analysis, kind === 'dislike').map((s) => ({
    ...s,
    weight,
  }))
  void persistSignals(supabase, userId, signals)
}

/**
 * 方向信号：用户选择某个迭代方向 = 希望该维度更强。
 * 目标定在 0.8（明确"想加强"但不锁死满分），权重较轻。
 * custom（自定义修改）没有可对应的固定维度，直接跳过。
 */
export function recordDirectionSignal(
  supabase: SupabaseClient,
  userId: string,
  direction: NextActionKey
): void {
  const dim = DIRECTION_DIMENSION[direction]
  if (!dim) return
  void persistSignals(supabase, userId, [{ dim, target: 0.8, weight: 0.5 }])
}
