// ============================================================
// WF7：推荐卡三段式视图模型（dashboard 消费）
//
// 把 API 行转换为「标题 / 为什么适合你 / 可以怎么创作」三段 +
// 可选的核心问题行 + 关联素材行。
//
// 回退规则（旧卡/模板卡五字段为 null，必须回退不白屏）：
//   whyForYou      = why_recommend ?? reason（模板理由兜底）
//   creationAngle  = creation_angle ?? null（无则整段隐藏）
//   coreQuestion   = reason_source==='ai' 时才展示（模板卡无此概念）
// ============================================================

export interface InspirationApiRow {
  title: string
  description: string
  reason: string
  why_recommend?: string | null
  creation_angle?: string | null
  core_question?: string | null
  related_knowledge?: string[] | null
  reason_source?: string | null
  rec_id?: string
}

export interface InspirationView {
  title: string
  /** 三段之一：为什么适合你（AI 理由优先，回退模板 reason） */
  whyForYou: string
  /** 三段之二：核心问题（仅 AI 卡展示；无值 null） */
  coreQuestion: string | null
  /** 三段之三：可以怎么创作（无则 null，UI 整段隐藏） */
  creationAngle: string | null
  /** 关联素材标题（闭集，≤3；空数组） */
  relatedKnowledge: string[]
  /** 理由来源（前端可据此展示小徽标；template 不展示） */
  reasonSource: 'ai' | 'template'
}

export function pickInspirationView(row: InspirationApiRow): InspirationView {
  const reasonSource: 'ai' | 'template' = row.reason_source === 'ai' ? 'ai' : 'template'
  const hasAiReason = reasonSource === 'ai' && !!row.why_recommend
  return {
    title: row.title,
    whyForYou: (hasAiReason ? row.why_recommend : row.reason) || row.reason || row.description,
    coreQuestion: hasAiReason ? (row.core_question ?? null) : null,
    creationAngle: hasAiReason ? (row.creation_angle ?? null) : null,
    relatedKnowledge: hasAiReason ? (row.related_knowledge ?? []).slice(0, 3) : [],
    reasonSource,
  }
}
