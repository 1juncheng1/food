// ============================================================
// styleProfileRepo —— style_profiles 的生成链路读取入口（唯一口径）
//
// 存在意义：creator_report（9.6）等画像列是后加的，不能假设所有环境都已迁移。
// 因此采用「宽列探测 + 按缺失列逐步降级」策略：
//   首次带上全部可选列；若库报 42703（undefined_column），从错误信息里解析出
//   缺失列名并剔除后重试，直到成功或用尽可选列，最后回退到静态旧列集合。
//
// 为何不用固定的两级常量：
//   新增列在加速累积（creator_declaration / interest_profile / 未来的
//   creator_knowledge）。写死「全量 vs 旧版」两档组合会指数膨胀，而且一旦任意
//   一个新列缺失，整档全量查询失败会连带丢掉本来可用的 creator_report。
//   按列降级可以把损失限定在「确实不存在的那一列」。
//
// 阶段五主页 / 控制中心统一读者时，读 profile 也走这里。
// ============================================================

import { createServerClient } from '@/lib/supabaseServer'

/** 所有环境都必然存在的基线列 */
const BASE_COLUMNS = [
  'tone_tags',
  'pace_preference',
  'common_opening',
  'avg_length',
  'creator_personality',
  'topic_preferences',
  'favorite_elements',
  'avoid_elements',
  'ai_creator_summary',
]

/**
 * 可选画像列（按引入时间从新到旧）。
 * 任意一列缺失都会让 PostgREST 报 42703，按列降级后仅丢失该列自身的数据。
 */
const OPTIONAL_COLUMNS = [
  'creator_knowledge', // Creator Intelligence System（Phase 2）
  'interest_profile', // Creator Understanding Engine（第十六节）
  'creator_declaration', // 用户主动声明（第十一节）
  'editing_profile', // AI 协作修改偏好记忆（10.3）
  'creator_report', // 9.6 创作者 DNA 报告
  'style_dimensions', // 五维行为画像
]

/** 兜底：连按列降级都失败时的静态旧列集合（等价于历史上的 COLUMNS_LEGACY） */
const LEGACY_COLUMNS = [...BASE_COLUMNS, 'style_dimensions']

/**
 * 从 PostgREST / Postgres 的 42703 错误信息里解析缺失列名。
 * 典型形态：
 *   column style_profiles.interest_profile does not exist
 *   column "interest_profile" does not exist
 * 解析失败返回 null，由调用方回退到静态旧列集合。
 */
function parseMissingColumn(message: string | undefined): string | null {
  if (!message) return null
  const m = /column\s+(?:[A-Za-z0-9_."]+?\.)?"?([A-Za-z0-9_]+)"?\s+does not exist/i.exec(message)
  return m?.[1] ?? null
}

/**
 * 读取用户风格卡（人格 / 画像 / 报告 / 关注领域 / 知识系统）。
 *
 * @param withVector 是否同时取 style_vector（向量检索场景才需要，默认不取 1024 维大列）
 */
export async function fetchCreatorStyleProfile(
  supabase: ReturnType<typeof createServerClient>,
  userId: string,
  withVector = false
): Promise<Record<string, unknown> | null> {
  const vectorCol = withVector ? ', style_vector' : ''

  // 可选列的当前可用集合（逐步剔除缺失列）
  let optional = [...OPTIONAL_COLUMNS]

  while (true) {
    const selectCols = [...BASE_COLUMNS, ...optional].join(', ')
    const res = await supabase
      .from('style_profiles')
      .select(`${selectCols}${vectorCol}`)
      .eq('user_id', userId)
      .maybeSingle()

    if (!res.error) {
      return (res.data as Record<string, unknown> | null) ?? null
    }

    if (res.error.code !== '42703') {
      console.error('读取风格卡失败:', res.error.message)
      return null
    }

    const missing = parseMissingColumn(res.error.message)
    if (!missing || !optional.includes(missing)) {
      // 解析不出列名 / 缺失的不是可选列 —— 说明库结构异常，回退静态旧列
      break
    }

    console.warn(`[styleProfile] 列 ${missing} 不存在（未执行迁移），本次降级剔除`)
    optional = optional.filter((c) => c !== missing)
    if (optional.length === 0) break
  }

  // 静态旧列兜底：保证最老的部署环境仍能生成
  const fallback = await supabase
    .from('style_profiles')
    .select(`${LEGACY_COLUMNS.join(', ')}${vectorCol}`)
    .eq('user_id', userId)
    .maybeSingle()

  if (fallback.error) {
    console.error('读取风格卡失败（回退列仍失败）:', fallback.error.message)
    return null
  }
  return (fallback.data as Record<string, unknown> | null) ?? null
}
