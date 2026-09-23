// ============================================================
// usageFilter —— 素材检索 usage 推断
//
// Phase 3 从 app/api/prompt-optimizer/route.ts 原样搬迁（搬迁不是重写）：
// 推断优先级：improve 模式 prevWorkTags.usage_tags > AI 方案 usage_tag >
// content_type → UsageTag 映射 > null。
//
// 注意（Phase 3 语义变化）：推断结果不再作为 match_scripts 的硬过滤参数，
// 仅作为 retrieveMaterials 带状软排序的意图信号（最多影响 ±0.02 相似度带内顺序）。
// ============================================================

import type { UsageTag } from '@/lib/creative/knowledgeItem'
import type { WorkTags } from '@/lib/creative/workAnalysis'

export const CATEGORY_TO_USAGE: Record<string, UsageTag> = {
  电影解说: '剧情素材',
  短剧解说: '剧情素材',
  纪录片解说: '案例素材',
  动漫解说: '剧情素材',
  故事文案: '剧情素材',
  读书解读: '观点素材',
  科普解说: '案例素材',
  剧本打磨: '结构参考',
  商业分析: '观点素材',
  商业计划书: '结构参考',
  产品评测: '案例素材',
}

export function inferUsageFilter(
  content_type: string,
  usage_tag: string | undefined,
  prevWorkTags: WorkTags | null
): UsageTag | null {
  // 1. improve 模式优先：上一版 work_tags 的 usage_tags 是 AI 分析过的可靠信号
  if (prevWorkTags?.usage_tags?.length) {
    return prevWorkTags.usage_tags[0]
  }
  // 2. 方案路径：AI 直接输出的 usage_tag（最准确）
  if (usage_tag) {
    return usage_tag as UsageTag
  }
  // 3. fallback：从 content_type 映射
  return CATEGORY_TO_USAGE[content_type] ?? null
}
