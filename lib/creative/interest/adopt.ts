// ============================================================
// WF1：adoptRecommendation —— 推荐采纳回流
//
// 触发点：/api/creative/plan 成功生成方案且请求携带 rec_id
// （用户从推荐卡点进创作 = 推荐被采纳，权重 1.5 的高价值正反馈）。
//
// 动作：markConsumed（卡片离队）→ recommend_adopt 事件 → fire-and-forget
// 增量重建。整个函数永不抛错：回流失败只记日志，绝不影响创作主流程。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { trackEvent } from './eventTracker'
import { markConsumed } from './suggestionRepo'
import { runBuild } from './builder'

export async function adoptRecommendation(
  supabase: SupabaseClient,
  userId: string,
  recId: string,
  topic: string
): Promise<void> {
  // 无 rec_id = 普通生成路径，与推荐系统无关，直接跳过
  if (!recId) return
  try {
    await markConsumed(supabase, recId)
    await trackEvent(supabase, userId, {
      type: 'recommend_adopt',
      targetType: 'inspiration',
      targetId: recId,
      topicExcerpt: topic || null,
      payload: { adopt_surface: 'plan' },
    })
    // serverless 可能冻结后台任务（known limitation，注释在案）；
    // 本地 dev / 长驻进程下正常生效
    void runBuild(supabase, userId, 'incremental').catch(() => {})
  } catch (e) {
    console.error('[interest] 采纳回流失败:', e instanceof Error ? e.message : e)
  }
}
