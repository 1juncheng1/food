// ============================================================
// 机会象限：由「价值分 + 竞争度」推导的展示态结论
//
// 纯函数、零依赖。单独成模块是为了让 'use client' 组件能直接用它，
// 而不必 import ./inspirationAnalyzer（后者含 DeepSeek 调用，属服务端模块）。
// ============================================================

export type OpportunityQuadrant =
  | 'blue_ocean' // 高分低竞争：蓝海机会
  | 'red_ocean' // 高分高竞争：红海需差异化
  | 'needs_refinement' // 低分低竞争：选题待优化
  | 'not_recommended' // 低分高竞争：不建议做

/** 根据 overall_score 和 competition_level 计算机会象限 */
export function getOpportunityQuadrant(
  overallScore: number,
  competitionLevel: number
): OpportunityQuadrant {
  const highScore = overallScore >= 5
  const highCompetition = competitionLevel >= 5
  if (highScore && !highCompetition) return 'blue_ocean'
  if (highScore && highCompetition) return 'red_ocean'
  if (!highScore && !highCompetition) return 'needs_refinement'
  return 'not_recommended'
}
