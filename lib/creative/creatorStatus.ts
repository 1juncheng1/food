// ============================================================
// creatorStatus —— Creator AI 对用户的"理解程度"评分（第六阶段）
//
// 设计原则：诚实优先。百分比只反映真实数据量，绝不虚标——
// 新用户就是 0%，AI 手里没有数据就说没有。
// 评分纯函数与展示文案集中在此，API 与页面共用同一口径。
// ============================================================

/** 用户冷启动阶段：forming=人格形成中 / learning=学习中 / ready=已就位 */
export type CreatorLevel = 'forming' | 'learning' | 'ready'

/** 参与评分的四路真实信号（计数为用户维度真实统计） */
export interface CreatorSignals {
  /** 历史作品数（generation_history，含修改迭代版本） */
  works: number
  /** 反馈次数（generation_feedback：like/dislike/edit/regenerate） */
  feedback: number
  /** 素材条数（scripts） */
  materials: number
  /** 是否已建立创作者人格档案（style_profiles 行存在） */
  hasProfile: boolean
}

export interface CreatorUnderstanding {
  /** 0-100 整数 */
  percent: number
  level: CreatorLevel
  signals: CreatorSignals
}

/** 各等级的主标题与引导语（页面直接渲染，三处共用不漂移） */
export const CREATOR_LEVEL_META: Record<
  CreatorLevel,
  { label: string; hint: string }
> = {
  forming: {
    label: '你的创作者人格正在形成',
    hint: '完成更多创作后，AI 会越来越了解你',
  },
  learning: {
    label: 'AI 正在加深对你的理解',
    hint: '继续创作与反馈，你的创作者人格画像会更完整',
  },
  ready: {
    label: '专属创作助手已就位',
    hint: 'AI 已建立你的创作者人格，会结合人格、素材库与历史作品创作',
  },
}

/** 单信号线性计分：cap 条封顶，满分 max */
function linearScore(count: number, cap: number, max: number): number {
  const n = Math.max(0, Math.min(count, cap))
  return (n / cap) * max
}

/**
 * 计算理解程度。
 * 权重：作品 45（10 篇满）+ 反馈 25（10 次满）+ 素材 15（10 条满）+ 人格建档 15。
 * 等级：<40 形成中；40-74 学习中；≥75 已就位（人格建档是"就位"的实质门槛之一）。
 */
export function computeCreatorUnderstanding(signals: CreatorSignals): CreatorUnderstanding {
  const raw =
    linearScore(signals.works, 10, 45) +
    linearScore(signals.feedback, 10, 25) +
    linearScore(signals.materials, 10, 15) +
    (signals.hasProfile ? 15 : 0)
  const percent = Math.min(100, Math.round(raw))

  const level: CreatorLevel = percent >= 75 ? 'ready' : percent >= 40 ? 'learning' : 'forming'
  return { percent, level, signals }
}
