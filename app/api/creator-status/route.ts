// ============================================================
// GET /api/creator-status —— 「AI 现在有多懂这个创作者」的唯一口径
//
// 改造背景：
//   此前理解度按 作品/反馈/素材/建档 四路线性计分，而 dashboard 另有一套
//   （直接读 interest_profile.identity.completeness）。两套口径并存，
//   且都回答不了「哪一路还缺数据、补什么最有价值」——用户只看到一个百分比。
//
//   现在统一走 lib/creative/creatorUnderstanding 的六路聚合：
//     memory（用户声明）/ interest（长期关注）/ report（创作 DNA）
//     / knowledge（已确认知识）/ style（风格画像）/ editing（修改偏好）
//   顺带把 signals 原样保留，/generate 页面现有的作品数展示不受影响。
//
// 约定：纯读取，无 AI 调用、无写入，任一路查询失败按 0 处理（偏保守，不虚标）。
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, type AuthResult } from '@/lib/apiAuth'
import { fetchCreatorStyleProfile } from '@/lib/creative/styleProfileRepo'
import { readCreatorUnderstanding } from '@/lib/creative/creatorUnderstanding'

export const dynamic = 'force-dynamic'

/**
 * 鉴权统一走 lib/apiAuth：网络故障 → 503「网络异常」（已登录用户不得踢），
 * 凭证失效 → 401。旧的内联 getUser + 一律返回 null 会把网络抖动伪装成"未登录"。
 */
async function authenticate(req: Request): Promise<AuthResult> {
  return authenticateRequest(req)
}

/** head count：只取 count 不取行，代价最低 */
async function countRows(
  supabase: SupabaseClient,
  table: string,
  userId: string
): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
  if (error) {
    console.error(`creator-status 统计 ${table} 失败:`, error.message)
    return 0
  }
  return count ?? 0
}

/**
 * 已确认的知识单元条数。
 * creator_knowledge 是后加的表（迁移 0005），未执行时查库会报 42P01；
 * 此时按 0 处理 —— 知识一路本来就该是"没有就是没有"，绝不猜一个数充数。
 */
async function countConfirmedKnowledge(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const { count, error } = await supabase
    .from('creator_knowledge')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', '已确认')
  if (error) {
    console.error('creator-status 统计已确认知识失败:', error.message)
    return 0
  }
  return count ?? 0
}

export async function GET(req: Request) {
  const auth = await authenticate(req)
  if (!auth.ok) return auth.response

  const { supabase, userId } = auth

  // 四路计数并行；任一路失败按 0 处理（进度条偏保守，不阻断）
  const [works, feedback, materials, confirmedKnowledge] = await Promise.all([
    countRows(supabase, 'generation_history', userId),
    countRows(supabase, 'generation_feedback', userId),
    countRows(supabase, 'scripts', userId),
    countConfirmedKnowledge(supabase, userId),
  ])

  // 六路画像列统一由 styleProfileRepo 读取（缺失列自动降级，未迁移环境不报错）
  const profile = await fetchCreatorStyleProfile(supabase, userId)

  const snapshot = readCreatorUnderstanding({
    declaration: profile?.creator_declaration,
    report: profile?.creator_report,
    interestProfile: profile?.interest_profile,
    styleDimensions: profile?.style_dimensions,
    editingProfile: profile?.editing_profile,
    confirmedKnowledge,
  })

  return NextResponse.json({
    ...snapshot,
    // 兼容字段：/generate 页面展示「已创作 N 篇」仍读 signals.works
    signals: {
      works,
      feedback,
      materials,
      hasProfile: !!profile,
    },
  })
}
