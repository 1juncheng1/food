import type { SupabaseClient } from '@supabase/supabase-js'

// ────────────────────────────────────────────────────────────
// 风格向量更新工具：用加权平均将新内容向量融入用户风格向量
// 公式：new_style = 0.8 * old_style + 0.2 * new_vector
// 权重 0.8/0.2 偏向历史风格，新内容仅微调，避免单次操作剧烈偏移
// ────────────────────────────────────────────────────────────

/** 旧向量权重（新向量权重 = 1 - OLD_WEIGHT） */
const OLD_WEIGHT = 0.8

/**
 * 解析 Supabase 返回的向量值（可能是数组或字符串 "[0.1,0.2,...]"）。
 * pgvector 列经 PostgREST 返回时通常为字符串格式。
 */
export function parseVector(v: unknown): number[] | null {
  if (Array.isArray(v) && v.length > 0) {
    return v as number[]
  }
  if (typeof v === 'string' && v.length > 2) {
    try {
      const arr = JSON.parse(v)
      if (Array.isArray(arr) && arr.length > 0) return arr as number[]
    } catch {
      // 非 JSON 格式，尝试去掉括号后逗号分割
      const trimmed = v.replace(/^\[|\]$/g, '')
      const parts = trimmed.split(',').map(Number).filter(Number.isFinite)
      if (parts.length > 0) return parts
    }
  }
  return null
}

/**
 * 计算多个向量的逐维平均值。
 * style_vector = 所有历史内容 embedding 的逐维平均
 */
export function averageVectors(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null
  const dim = vectors[0].length
  const result = new Array(dim).fill(0)
  for (const vec of vectors) {
    for (let i = 0; i < dim && i < vec.length; i++) {
      result[i] += vec[i]
    }
  }
  for (let i = 0; i < dim; i++) {
    result[i] /= vectors.length
  }
  return result
}

/**
 * 余弦相似度（0-1；输入不合法或任一为零向量时返回 null）。
 * 第七阶段：本篇作品 embedding × 用户 style_vector → "语言风格一致度"真实展示值。
 */
export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (!a?.length || !b?.length) return null
  const dim = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < dim; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return null
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * 加权平均：new = OLD_WEIGHT * old + (1 - OLD_WEIGHT) * input
 * 如果 old 为 null（用户尚无风格向量），直接使用 input 作为初始值。
 */
export function weightedAverage(oldVec: number[] | null, newVec: number[]): number[] {
  if (!oldVec || oldVec.length === 0) {
    return [...newVec]
  }
  const dim = Math.min(oldVec.length, newVec.length)
  const result = new Array(dim).fill(0)
  for (let i = 0; i < dim; i++) {
    // 加权平均：new = 0.8 * old + 0.2 * new
    result[i] = OLD_WEIGHT * oldVec[i] + (1 - OLD_WEIGHT) * newVec[i]
  }
  return result
}

/**
 * 更新用户风格向量（upsert 到 style_profiles 表）。
 *
 * 逻辑：
 *   1. 查询 style_profiles 中是否已有 style_vector
 *   2. 有：加权平均（0.8 * old + 0.2 * new）后更新
 *   3. 无：直接用 newVector 作为初始值插入
 *
 * 此函数不抛异常：风格更新失败仅 console.error，不阻断调用方主流程。
 * 调用方应为非关键路径（帖子发布/素材保存成功后的后置操作）。
 *
 * @param supabase 已带用户 token 的 Supabase 客户端
 * @param userId 用户 ID
 * @param newVector 新内容的 embedding（1024 维）
 */
export async function updateUserStyleVector(
  supabase: SupabaseClient,
  userId: string,
  newVector: number[]
): Promise<void> {
  try {
    if (!newVector || newVector.length === 0) return

    // 查询现有风格向量 + 风格卡字段（upsert 时需保留原值）
    const { data: existing, error: selErr } = await supabase
      .from('style_profiles')
      .select('style_vector, tone_tags, pace_preference, common_opening, avg_length, source')
      .eq('user_id', userId)
      .maybeSingle()

    if (selErr) {
      console.error('查询风格向量失败:', selErr)
      return
    }

    const oldVec = parseVector(existing?.style_vector)
    const updatedVec = weightedAverage(oldVec, newVector)

    // upsert：有记录则更新 style_vector，无则插入
    const { error: upsertErr } = await supabase
      .from('style_profiles')
      .upsert(
        {
          user_id: userId,
          style_vector: updatedVec,
          // 如果是新记录，设置默认风格卡字段
          tone_tags: existing?.tone_tags ?? [],
          pace_preference: existing?.pace_preference ?? '未知',
          common_opening: existing?.common_opening ?? '未知',
          avg_length: existing?.avg_length ?? 0,
          source: existing?.source ?? 'auto',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      )

    if (upsertErr) {
      console.error('更新风格向量失败:', upsertErr)
    }
  } catch (e) {
    console.error('updateUserStyleVector 异常:', e)
  }
}
