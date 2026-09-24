// ============================================================
// GET /api/creator-status —— Creator AI 理解程度（第六阶段冷启动机制）
//
// 登录用户查询四路真实学习信号（作品/反馈/素材/人格建档），
// 计算理解程度百分比与冷启动等级，供生成页"我的模式"面板展示。
// 纯计数读取，无 AI 调用、无写入，失败不影响任何生成链路。
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, type AuthResult } from '@/lib/apiAuth'
import { fetchCreatorStyleProfile } from '@/lib/creative/styleProfileRepo'
import { computeCreatorUnderstanding } from '@/lib/creative/creatorStatus'

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

export async function GET(req: Request) {
  const auth = await authenticate(req)
  if (!auth.ok) return auth.response

  const { supabase, userId } = auth

  // 四路信号并行统计；任一路失败按 0 处理（进度条偏保守，不阻断）
  const [works, feedback, materials] = await Promise.all([
    countRows(supabase, 'generation_history', userId),
    countRows(supabase, 'generation_feedback', userId),
    countRows(supabase, 'scripts', userId),
  ])

  // 人格建档：style_profiles 行存在即视为"档案已建立"（9.5 声明/9.6 报告/五维画像任一）
  const profile = await fetchCreatorStyleProfile(supabase, userId)

  return NextResponse.json(
    computeCreatorUnderstanding({
      works,
      feedback,
      materials,
      hasProfile: !!profile,
    })
  )
}
