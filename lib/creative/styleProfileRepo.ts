// ============================================================
// styleProfileRepo —— style_profiles 的生成链路读取入口（唯一口径）
//
// 存在意义：creator_report（9.6）是后加列，不能假设所有环境都已执行迁移。
// 首次查询带上新列；若库报 42703（列不存在），自动用旧列集合重查一次——
// 未迁移环境降级为 9.5 散列人格，生成链路永不因迁移顺序中断。
// 阶段五主页/控制中心统一读者时，读 profile 也走这里。
// ============================================================

import { createServerClient } from '@/lib/supabaseServer'

/** 9.6 之后的完整列（不含 style_vector，非向量场景默认不取 1024 维大列） */
const COLUMNS_FULL =
  'tone_tags, pace_preference, common_opening, avg_length, style_dimensions, editing_profile, creator_personality, topic_preferences, favorite_elements, avoid_elements, ai_creator_summary, creator_report'

/** 9.6 未迁移时的回退列 */
const COLUMNS_LEGACY =
  'tone_tags, pace_preference, common_opening, avg_length, style_dimensions, creator_personality, topic_preferences, favorite_elements, avoid_elements, ai_creator_summary'

/**
 * 读取用户风格卡（人格/画像/报告）。
 * @param withVector 是否同时取 style_vector（向量检索场景才需要，默认不取）
 */
export async function fetchCreatorStyleProfile(
  supabase: ReturnType<typeof createServerClient>,
  userId: string,
  withVector = false
): Promise<Record<string, unknown> | null> {
  const vectorCol = withVector ? ', style_vector' : ''

  const first = await supabase
    .from('style_profiles')
    .select(`${COLUMNS_FULL}${vectorCol}`)
    .eq('user_id', userId)
    .maybeSingle()

  // 42703 = undefined_column：9.6（或更早）迁移未执行 → 旧列降级重查
  if (first.error) {
    if (first.error.code === '42703' || /column .* does not exist/i.test(first.error.message)) {
      const fallback = await supabase
        .from('style_profiles')
        .select(`${COLUMNS_LEGACY}${vectorCol}`)
        .eq('user_id', userId)
        .maybeSingle()
      if (fallback.error) {
        console.error('读取风格卡失败（回退列仍失败）:', fallback.error.message)
        return null
      }
      return (fallback.data as Record<string, unknown> | null) ?? null
    }
    console.error('读取风格卡失败:', first.error.message)
    return null
  }

  return (first.data as Record<string, unknown> | null) ?? null
}
