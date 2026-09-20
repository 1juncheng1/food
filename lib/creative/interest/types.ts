// ============================================================
// Creator Interest Profile —— 类型定义（M1 事件层）
//
// 事实流 creator_events 的全部类型契约集中在此：
//   事件不可变（只增不改不删），撤回语义用新事件表达；
//   枚举与 setup.sql 第 16.4 节的 CHECK 约束保持同步，
//   扩枚举时两边一起改（应用层枚举为主，CHECK 仅兜底）。
// ============================================================

/** 用户行为事件类型（21 种，权重见 config.EVENT_REGISTRY） */
export type CreatorEventType =
  // 作品生命周期
  | 'work_generate'
  | 'work_finalize'
  | 'work_unfinalize'
  | 'work_delete'
  // 作品反馈
  | 'feedback_like'
  | 'feedback_dislike'
  | 'work_edit'
  | 'work_regenerate'
  // 素材库
  | 'material_save'
  | 'material_delete'
  // 广场互动
  | 'post_like'
  | 'post_unlike'
  | 'post_save'
  | 'post_unsave'
  | 'post_style_resonate'
  // 主动意图
  | 'inspiration_analyze'
  | 'topic_search'
  // 推荐闭环
  | 'recommend_impression'
  | 'recommend_click'
  | 'recommend_adopt'
  | 'recommend_dismiss'

/** 行为对象类型 */
export type TargetType =
  | 'generation'
  | 'project'
  | 'script'
  | 'post'
  | 'inspiration'
  | 'ci_item'
  | 'topic'

/** AI 行为原因分析状态 */
export type InterpretStatus = 'none' | 'pending' | 'done' | 'failed'

/** 事件在评分中的效果（M2 scoring 消费，M1 仅随配置声明） */
export type EventEffect = 'contribute' | 'negative' | 'withdraw' | 'stats_only'

/**
 * 原因分析策略：
 *   yes    —— 落库即 pending，build 时批量解释（低频高价值事件）
 *   sample —— M1 先落 none，M2 解释流水线按抽样比例挑选（素材保存量大）
 *   no     —— 永不解释（高频/显式行为）
 */
export type InterpretMode = 'yes' | 'sample' | 'no'

/** trackEvent 入参 */
export interface TrackEventInput {
  type: CreatorEventType
  targetType: TargetType
  /** 行为对象 ID；纯主题行为（topic_search）可空 */
  targetId?: string | null
  /** 关联创作项目（项目封顶去重的核心字段，能拿到就一定传） */
  projectId?: string | null
  /** 形式分类（电影解说…），辅助维度，不确定传 null */
  category?: string | null
  /** 粗领域（tech/business…），辅助维度 */
  contentDomain?: string | null
  /**
   * 主题语义向量：
   *   显式传入（含 null=调用方已尝试但失败）→ 直接使用，不重复计算；
   *   不传（undefined）+ topicExcerpt + 配置允许 → tracker 自动补算。
   */
  embedding?: number[] | null
  /** 主题摘录（≤100 字），既进 payload 也用于自动补算 embedding */
  topicExcerpt?: string | null
  /** 事件附加信息（tracker 会做截断/清洗） */
  payload?: Record<string, unknown>
  /** 行为发生时间（回填用）；默认 now() */
  occurredAt?: string | Date
  /**
   * 幂等键按天加日期后缀：
   * 同一 target 的反复动作（定稿/撤回/编辑/重做）需要每天各自入账时置 true。
   */
  dailyKey?: boolean
}

/** trackEvent 结果（永不抛异常，失败只体现在 ok=false） */
export interface TrackEventResult {
  ok: boolean
  /** 实际写入用的幂等键（日志/调试用） */
  idempotencyKey: string
  /** 重复上报被幂等吞掉时为 true */
  duplicated?: boolean
}

// ============================================================
// 计算引擎（M2）消费的内部类型
// ============================================================

/** AI 行为原因码（与 reasonAnalyzer 输出契约一致） */
export type ReasonCode =
  | 'genuine_interest'
  | 'testing_feature'
  | 'narrative_research'
  | 'work_assignment'
  | 'social_follow'
  | 'accidental'
  | 'other'

/** creator_events.interpretation 的最小消费结构（其余字段审计用，引擎不读） */
export interface ReasonInterpretation {
  reasons: Array<{ code: ReasonCode | string; probability: number }>
}

/**
 * 评分引擎输入事件（从 creator_events 行映射而来；映射在 M2b builder 中做）。
 * 这是纯函数世界的边界类型：不依赖 Supabase 行结构，便于单测构造种子数据。
 */
export interface EngineEvent {
  id: string
  type: CreatorEventType
  targetType: TargetType
  targetId: string | null
  projectId: string | null
  occurredAt: string // ISO
  /** WF3：事件归属簇（build 时由内存聚类写入；刚入库未 build 的事件为 null） */
  clusterId?: string | null
  embedding?: number[] | null
  /** AI 原因分析；null/undefined = 未解释（按 genuine 处理，不惩罚用户） */
  interpretation?: ReasonInterpretation | null
}

/** 兴趣三层 */
export type InterestLayer = 'core' | 'exploration' | 'temporary'

/** 趋势方向 */
export type TrendDirection = 'rising' | 'stable' | 'declining' | 'dormant'

/** WF4：四维标签（内容/思想/情绪/创作方式，各 ≤5） */
export interface TagDims {
  content: string[]
  thought: string[]
  emotion: string[]
  craft: string[]
}
