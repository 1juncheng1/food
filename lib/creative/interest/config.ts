// ============================================================
// Creator Interest Profile —— 全局配置（唯一允许出现权重/阈值数字的地方）
//
// 铁律：业务代码不得出现魔法数。调任何一个数字 = RULE_VERSION 升版，
// 该版本号会写进 interest_builds.rule_version 与画像 jsonb，
// 使任意一次画像结果都可归因到具体规则版本。
//
// M1 只消费 INTERPRET/截断/限流相关项；
// 权重与阈值整表提前落位，M2 scoring/builder 直接引用，避免二期再改契约。
// ============================================================

import type { CreatorEventType, EventEffect, InterpretMode, ReasonCode, TrendDirection } from './types'
import type { SuggestionSlot } from './ranking'

/** 权重/分层规则版本（M2 起写入 build 记录） */
export const RULE_VERSION = 'interest-rules-v2'

/** 聚类算法版本（M2 使用，此处先声明） */
export const ALGO_VERSION = 'interest-cluster-v1'

/** 嵌入模型标识（与 lib/storage.generateEmbedding 的 bge-m3 对齐） */
export const EMBEDDING_MODEL = 'bge-m3@1024'

// ── 文本截断红线 ──
export const TOPIC_EXCERPT_MAX = 100 // 事件主题摘录
export const PAYLOAD_TEXT_MAX = 300 // payload 内其他文本字段
export const RATIONALE_MAX = 80 // 行为原因一句话说明

// ── 上报限流（事件 API 启用时用） ──
export const EVENT_RATE_LIMIT_PER_MIN = 60
export const EVENT_BATCH_MAX = 50

/**
 * 事件注册表：基础权重 / 效果 / 原因分析策略 / 是否自动补 embedding。
 *
 * 权重口径（2026-09 设计评审版，用户已确认）：
 *   impression=0（只做 CTR 分母，绝不进兴趣分）
 *   dislike=-0.3（👎 多否定生成质量而非主题，弱负分；主题厌恶权威信号是 dismiss）
 *   dismiss=-1.5（唯一明确的主题级负反馈）
 */
interface EventRegistryEntry {
  weight: number
  effect: EventEffect
  interpret: InterpretMode
  /** 无显式向量时，是否允许用 topicExcerpt 自动补算 embedding */
  autoEmbedding: boolean
}

export const EVENT_REGISTRY: Record<CreatorEventType, EventRegistryEntry> = {
  work_generate: { weight: 1.0, effect: 'contribute', interpret: 'yes', autoEmbedding: false },
  work_finalize: { weight: 3.0, effect: 'contribute', interpret: 'no', autoEmbedding: false },
  work_unfinalize: { weight: 0, effect: 'withdraw', interpret: 'no', autoEmbedding: false },
  work_delete: { weight: -0.5, effect: 'negative', interpret: 'no', autoEmbedding: false },

  feedback_like: { weight: 1.0, effect: 'contribute', interpret: 'no', autoEmbedding: false },
  feedback_dislike: { weight: -0.3, effect: 'negative', interpret: 'no', autoEmbedding: false },
  work_edit: { weight: 0.3, effect: 'contribute', interpret: 'no', autoEmbedding: false },
  work_regenerate: { weight: 0.3, effect: 'contribute', interpret: 'no', autoEmbedding: false },

  material_save: { weight: 1.2, effect: 'contribute', interpret: 'sample', autoEmbedding: false },
  material_delete: { weight: 0, effect: 'withdraw', interpret: 'no', autoEmbedding: false },

  post_like: { weight: 0.6, effect: 'contribute', interpret: 'no', autoEmbedding: false },
  post_unlike: { weight: 0, effect: 'withdraw', interpret: 'no', autoEmbedding: false },
  post_save: { weight: 1.5, effect: 'contribute', interpret: 'yes', autoEmbedding: false },
  post_unsave: { weight: 0, effect: 'withdraw', interpret: 'no', autoEmbedding: false },
  post_style_resonate: { weight: 1.2, effect: 'contribute', interpret: 'no', autoEmbedding: false },

  inspiration_analyze: { weight: 1.0, effect: 'contribute', interpret: 'yes', autoEmbedding: true },
  topic_search: { weight: 0.5, effect: 'contribute', interpret: 'yes', autoEmbedding: true },

  recommend_impression: { weight: 0, effect: 'stats_only', interpret: 'no', autoEmbedding: false },
  recommend_click: { weight: 0.15, effect: 'contribute', interpret: 'no', autoEmbedding: false },
  recommend_adopt: { weight: 1.5, effect: 'contribute', interpret: 'yes', autoEmbedding: false },
  recommend_dismiss: { weight: -1.5, effect: 'negative', interpret: 'no', autoEmbedding: false },
}

// ── 评分参数（M2 消费，提前锁定） ──
export const HALF_LIFE_DAYS = 45
export const SCORING_WINDOW_DAYS = 365

// ── WF5 评分公式 v2（业务侧唯一参数面，调任一数字即需再升 RULE_VERSION） ──
// Score = InterestMatch×0.4 + RecentBehavior×0.2 + Trend×0.2 + Quality×0.1 + Explore×0.1
export const RANKING_WEIGHTS_V2 = {
  interestMatch: 0.4,
  recentBehavior: 0.2,
  trend: 0.2,
  quality: 0.1,
  explore: 0.1,
} as const

/** InterestMatch 内部构成：0.7×语义匹配 + 0.3×标签命中（WF4 接入真实四维标签） */
export const INTEREST_SEMANTIC_RATIO = 0.7
export const INTEREST_TAG_RATIO = 0.3
/** 语义余弦相似度归一化：[floor, floor+range] → [0,1]；bge-m3 相关内容典型 0.5-0.8 */
export const SEMANTIC_SIM_FLOOR = 0.4
export const SEMANTIC_SIM_RANGE = 0.6
/** 无簇候选的语义分：探索源给地板（不打高分但不至零），其他源 0 */
export const EXPLORATION_SEMANTIC_FLOOR = 0.3

/** 趋势方向 → trend 因子分 */
export const TREND_FACTOR: Record<TrendDirection, number> = {
  rising: 1,
  stable: 0.7,
  declining: 0.3,
  dormant: 0.15,
}

/** 槽位 → explore 因子分（越"探索/缺口"越高） */
export const EXPLORE_SLOT_FACTOR: Record<SuggestionSlot, number> = {
  exploration: 1,
  core_gap: 0.55,
  evidence_followup: 0.4,
  continuation: 0.2,
}

/** RecentBehavior 阶梯：距该簇最近事件 ≤maxDays → score；null=无事件用 RECENCY_NO_EVENTS */
export const RECENCY_LADDER: ReadonlyArray<readonly [maxDays: number, score: number]> = [
  [3, 0.95],
  [7, 0.85],
  [14, 0.7],
  [30, 0.5],
  [60, 0.3],
  [Number.POSITIVE_INFINITY, 0.15],
]
export const RECENCY_NO_EVENTS = 0.5

/**
 * 行为原因折扣系数：事件有效分 × Σ(原因概率 × 对应系数)。
 * 未解释/解释失败不在此表——scoring 直接按 1.0 处理（不能因 LLM 挂了惩罚用户）。
 */
export const REASON_FACTORS: Record<ReasonCode, number> = {
  genuine_interest: 1.0,
  narrative_research: 0.7,
  social_follow: 0.5,
  work_assignment: 0.3,
  testing_feature: 0.1,
  accidental: 0.05,
  other: 0.5,
}
/** 未知原因码的兜底折扣（宁可宽松，不误伤） */
export const REASON_FACTOR_UNKNOWN = 0.5

export const PROJECT_CAP_PER_CLUSTER = 3.0
export const LOOSE_TARGET_CAP = 1.5

// ── 分层阈值（M2 消费） ──
export const TEMPORARY_BURST_DAYS = 7
export const TEMPORARY_GRACE_DAYS = 14
export const EXPLORATION_PROMOTE_DAYS = 21
export const CORE_MIN_AGE_DAYS = 30
export const CORE_MIN_PROJECTS = 3
export const CORE_MIN_EVENTS = 5
export const CORE_MIN_WEIGHT = 0.55
export const CORE_MIN_GENUINE_RATIO = 0.6
export const DOWNGRADE_STREAK = 2

// ── 聚类参数（M2 消费） ──
export const CLUSTER_DISTANCE_THRESHOLD = 0.28
export const CLUSTER_MIN_MEMBERS = 2
export const CLUSTER_INHERIT_SIMILARITY = 0.72
export const MAX_ACTIVE_CLUSTERS = 12

// ── WF11 P1：多兴趣广度（S4 exploration 消费） ──
// 单簇探索种子上限：一次 build 喂给 LLM 的用户兴趣方向数（core 优先，不足补 exploration 层）
export const EXPLORATION_MAX_SEEDS = 6
// S4 批量生成条数：新用户场景 S1/S3/S5 全空，队列全靠 S4 独撑，
// 16 条实测不满足 AC-2（≥20），提到 24 保证 hardFilter 后仍 ≥20。
export const EXPLORATION_BATCH_SIZE = 24
// AI 理由生成的候选卡数量上限：扩批后理由 LLM 覆盖面同步从 6 扩到 20
export const AI_REASON_TOP_N = 20

// ── Build 调度（M2/M3/M4 消费） ──
// 2026-09-18 数据闭环修复：增量 build 已改为全窗口确定性重算（fetchEvents 不再按
// 游标截断），单次 build 成本上升但结果可复现；触发阈值相应放宽，让新增/删除少量
// 作品能在下一次进页时反映到推荐队列——1 个作品仅产生 1~3 条事件，
// 旧阈值（20 条脏事件 / 6 小时过期）意味着日常操作几乎永远够不着触发条件。
export const BUILD_DIRTY_EVENT_COUNT = 5

/**
 * running build 新鲜窗口（毫秒）。build 正常耗时 20-150s（embedding 补算 + 3 次 LLM），
 * 超过 5 分钟仍 running 的行视为僵尸（dev 热重载 / serverless 冻结 / 进程退出遗留）：
 *   - findRunningBuild 忽略它（不再折叠新 build、前端不再永久显示"分析中"）
 *   - reapStaleRunningBuild 将其置 failed 收尾
 */
export const BUILD_STALE_RUNNING_MS = 5 * 60_000
export const BUILD_MAX_AGE_HOURS = 1
/** 新用户首建：无画像用户行为事件达到该值时，/api/inspirations 自动触发首次 full build */
export const FIRST_BUILD_MIN_EVENTS = 5
export const INTERPRET_BATCH_SIZE = 20
export const INTERPRET_WINDOW_DAYS = 90

// ── 趋势参数（M2 trends 消费） ──
export const TRENDS_EWMA_ALPHA = 0.5 // 新窗口权重
/** |slope| 超过该阈值判定上升/下降；d7 窗口零贡献判定 dormant */
export const TREND_SLOPE_RISING = 0.1
export const TREND_SLOPE_DECLINING = -0.1

// ── 置信度参数（M2 confidence 消费） ──
export const CONFIDENCE_WEIGHTS = {
  project: 0.35, // 去重项目数（≥3 满分）
  event: 0.25, // 事件数（≥8 满分）
  interpretCoverage: 0.2, // 需解释事件的解释覆盖率
  freshness: 0.1, // 近 90 天事件占比
  spread: 0.1, // 项目离散度
} as const
export const CONFIDENCE_PROJECT_FULL = 3
export const CONFIDENCE_EVENT_FULL = 8
export const CONFIDENCE_FRESH_WINDOW_DAYS = 90
/** 去重项目 <2 时置信度硬上限（单次孤立行为不允许高置信） */
export const CONFIDENCE_LOW_PROJECT_CAP = 0.4
