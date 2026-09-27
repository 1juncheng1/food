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

/**
 * 权重/分层规则版本（M2 起写入 build 记录）。
 * v3：build 内新增「未被任何入选簇吸收的新作品」探索种子（数据闭环修复，
 *     不改变评分公式与任何既有数字，仅扩大种子来源）。
 * v4：评分公式 v2(5 维) → v3(7 维)，近期创作行为与个人知识资产独立成维。
 *     这是一次真实的重排（interestMatch 0.4 → 0.16），必须整体重建画像。
 * v5：评分从「写时定死」改为「读时计算」（rescore.ts）。落库的推荐卡必须额外
 *     携带 ranking_features + embedding，否则无法在线重排 → 队列整体换血一次。
 *     这是最后一次因"口径升级"需要清空队列的迁移：此后调评分权重不再需要重建。
 * v6：v5 的换血实际上**从未发生**，所以补一次。
 *     库里 1331 张卡、embedding 非空的 0 张，ranking_features 全是 '{}'——
 *     不是代码没写，而是 v5 升版当时迁移 0018（embedding / ranking_features
 *     两列）还没执行进库，insertSuggestions 每次都命中"新列不存在"降级、
 *     静默把这两列剥掉重插。卡片照常落库，所以线上完全无感。
 *     后果是 v5 之后建的整条链路全是死代码：候选→簇匹配恒 0%、在线重排
 *     对所有卡不生效、曝光—反馈闭环学不到任何方向。
 *     现在两列已就位（已实测确认列存在），升到 v6 只为触发一次真实换血，
 *     让卡真正带上向量与特征。评分公式与任何权重数字均未改动。
 *
 * v7：放宽"单成员簇"进画像的门槛 —— 含作品级强信号（写完/定稿/发布）的簇，
 *     即使只有 1 个成员也纳入 scored。这是聚类口径变更（进画像的方向集合变了），
 *     不是评分权重调整，所以必须升版触发一次重建。
 *     实测依据见下方 WORK_LEVEL_EVENT_TYPES 的存在理由。
 */
export const RULE_VERSION = 'interest-rules-v7'

/**
 * 在线重排版本（读路径 scorer 的特征契约）。
 *
 * 为什么和 RULE_VERSION 拆开：v5 起 score 不在写库时算死，而是读的时候由
 * ranking_features 现场算。于是"调评分权重"的代价从"全量重建画像 + 清空队列 +
 * 烧 3 次 LLM"降为"改一行代码"。二者的失效半径完全不同：
 *   - RULE_VERSION 失效 → 画像口径不合	new舊 → 必须重跑聚类/ LLM（贵）
 *   - RANKING_VERSION 失效 → 只是这批卡缺了某个新维度 → 退回库 score 即可（免费）
 *
 * 升这里的唯一理由：features 集合自身变了（新增/改名/改语义）。
 * 落库时把版本写进 ranking_features.ranking_version，读时逐行比对，
 * 不匹配就跳过在线重排——宁可退回旧分，也不能让不同特征契约的卡同队列混排。
 */
export const RANKING_VERSION = 'interest-ranking-v1'

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
  // 发布 = 作品生命周期的终点，也是最强意图：用户不仅完成了作品，还愿意公开它。
  // 权重高于 work_finalize(3.0)：定稿是「我认可」，发布是「我愿意让世界看到」。
  // interpret='yes'：发布是低频高价值信号，值得做原因分析（为什么愿意发这个）。
  work_publish: { weight: 4.0, effect: 'contribute', interpret: 'yes', autoEmbedding: false },

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

// ── WF5 评分公式 v3（业务侧唯一参数面，调任一数字即需再升 RULE_VERSION） ──
//
// v2 → v3 的变化：把「近期创作行为」和「个人知识资产」从 interestMatch 里拆出来，
// 变成两个可独立观测、可独立调参的维度。v2 里这两件事全被压在一个
// interestMatch=0.4 里，结果就是"推荐永远在复述历史作品"——
// 用户刚写完一篇新方向，历史相似度仍然压倒一切。
//
// v3 权重顺序严格对齐产品定义的优先级链：
//   近期创作行为(recency 0.26)
//   > 近期兴趣变化(trend 0.14 + recentBehavior 0.10 = 0.24)
//   > 个人知识库(knowledge 0.18)
//   > 历史作品 / 长期偏好(interestMatch 0.16)
//
// quality / explore 是内容与多样性修正项，不在优先级链内。
//
// 可调性说明：recency 与 knowledge 在信号缺失时（无近期事件 / 无知识单元）
// 由 ranking.ts 按比例把权重重分配给其余维度，而不是按 0 计——
// 否则没有知识库的用户会被整体压低 0.18，那是惩罚而非中性。
export const RANKING_WEIGHTS_V3 = {
  recency: 0.26,
  interestMatch: 0.16,
  knowledge: 0.18,
  trend: 0.14,
  recentBehavior: 0.1,
  quality: 0.1,
  explore: 0.06,
} as const

/** recency 语义相似度归一化：[floor, floor+range] → [0,1] */
export const RECENCY_SIM_FLOOR = 0.4
export const RECENCY_SIM_RANGE = 0.6
/**
 * 单张候选拿不到向量（S6 知识卡等）时的 recency 相似度取值。
 *
 * 为什么给中性而不是让该维度"缺席"：缺席会触发权重重分配，于是同一批候选里
 * 有向量的卡按 7 维算、没向量的卡按 6 维算——两者的 score 不在同一把尺子上，
 * 排序直接失真。整批都算不出（无质心）时仍然返回 null 走重分配，那是全体一致。
 *
 * 取 0.7 = floor + 0.5×range，归一化后正好落在 0.5 中性。
 */
export const RECENCY_NO_SIGNAL_SIM = 0.7
/**
 * 「近期行为质心」的时间衰减半衰期（天）。
 * 45 天是画像整体半衰期（HALF_LIFE_DAYS），这里刻意更短：recency 要表达的是
 * "这两周你在做什么"，不是"这半年你在做什么"。
 */
export const RECENT_BEHAVIOR_HALF_LIFE_DAYS = 21

/**
 * ✕ 原因 → 得分乘子（Taste Model 的最小可用形态）。
 *
 * 为什么不改权重而用乘子：原因表达的是"这张卡能不能要"，不是"这个方向重不重要"。
 * 权重改动会影响整簇所有卡，乘子只作用于被判定的那张卡所在的簇，
 * 语义上更接近用户的真实意图，也更容易回滚。
 *
 * 同簇多次 ✕ 不叠加：叠加会让"越点越死"，把探索空间彻底封死（取最强的一个）。
 */
export const TASTE_PENALTY: Record<DismissReasonCode, number> = {
  not_my_direction: 0.55,
  not_interesting: 0.7,
  already_created: 0.75,
  not_my_voice: 0.85,
  too_hard: 0.9,
}
/** ✕ 但未选原因（兼容旧客户端与"就是不想看"）：按最轻档处理 */
export const TASTE_PENALTY_NO_REASON = 0.85
/** 口味惩罚的回看窗口（天）：半年前的"不感兴趣"不该继续约束现在的创作者 */
export const TASTE_PENALTY_WINDOW_DAYS = 90

/**
 * 槽位级口味约束：同一个 ✕ 原因对不同槽位的含义不同，乘子不该一刀切。
 *
 * 唯一的实际用例是「已经创作过」：它说的不是"这个方向我不想要"，
 * 而是"这条脉络我已经写过了"。推 continuation（延续你之前的创作）等于把
 * 用户刚写完的东西换个说法再推一遍——正是 ✕ 的理由本身。
 * 同方向的 core_gap（换个角度切入）仍然值得推，所以只压 continuation。
 */
export const TASTE_SLOT_PENALTY: Partial<
  Record<DismissReasonCode, Partial<Record<SuggestionSlot, number>>>
> = {
  already_created: { continuation: 0.6 },
  not_my_direction: { continuation: 0.7 },
}

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

/**
 * 作品级强信号事件类型：写完 / 定稿 / 发布。
 *
 * 存在理由（2026-09-25 生产实测）：CLUSTER_MIN_MEMBERS=2 会滤掉**全部**单成员簇，
 * 而跨领域创作者的常态就是「N 篇作品 N 个方向」——每簇只有 1 个成员。实测两个账号：
 *   23 个原始簇里 21 个是单成员 → 最终只有 2 个方向进画像
 *   3  个原始簇里 2  个是单成员 → 最终只有 1 个方向进画像
 * 画像只剩一两个方向，造卡就只能围着它反复改写，推荐退化成"刷来刷去都是这几张"；
 * 同时绝大多数卡拿不到簇（semanticSimilarity=null），在线重排对它们全部失效。
 * 这条限制代码里早就标注过（wf9：泛商业 5 主题两两相似度不达标 → 各自单成员 →
 * 被 MIN_MEMBERS 滤掉，"多样本聚类放宽留 follow-up"），本常量就是那个 follow-up。
 *
 * 为什么只放宽作品级，而不是把 MIN_MEMBERS 直接降成 1：
 *   作品是创作者真实投入的产物（写完/定稿/发布），一篇就足以证明一个方向；
 *   而曝光、点击、点赞这类弱行为单次噪声太大——误点一下不该变成一个兴趣方向，
 *   它们仍必须凑够 CLUSTER_MIN_MEMBERS 才被承认。这样放宽不引入弱信号噪声。
 */
export const WORK_LEVEL_EVENT_TYPES = [
  'work_generate',
  'work_finalize',
  'work_publish',
] as const

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

/**
 * 画像"时间过期"触发重建的小时数。
 *
 * ⚠ 这个数字直接决定 LLM 成本与后台负载，改动前务必理解它触发的是什么：
 *   命中后走 runBuild —— 全窗口重算聚类 + 3 次 LLM，耗时 20-150s。
 *
 *   注意它**不会**造成"用户看不到推荐"：builder 早已改成「先落新卡、
 *   再 supersedeExceptBuild 按 build_id 清旧卡」的原子切换（见 suggestionRepo），
 *   重建的 20-150s 里旧卡照常服务。所以这里的代价是算力与金钱，不是空窗期。
 *   （本注释此前误写成"第一步 supersedeOldBuild 清空队列"，是照抄了下面
 *    WF12 段里一段没跟着代码更新的旧描述，已一并订正。）
 *
 * 从 1 → 24 的理由：
 *   1) 它是"什么都不做也会重建"的唯一通道。真实行为早已由更快的通道覆盖：
 *      作品增删走 work_signal（1 条即触发，refill 秒级）、一般行为走 dirty（≥5 条）。
 *      于是 1h 过期剩下的作用只有"用户毫无动静时每小时烧一次 3 次 LLM"，
 *      而毫无动静恰恰意味着画像不需要更新——纯浪费。
 *   2) 画像表达的是长期偏好（HALF_LIFE_DAYS=45 天）。一个人的创作方向不会
 *      一小时一变，24h 更新一次绰绰有余。
 *   3) RULE v5 之后 score 改为读时计算（rescore.ts），画像只提供簇/质心/分层。
 *      即使画像稍旧，排序仍按"此刻"的上下文重算，新鲜度的实际影响进一步缩小。
 *
 * 收紧这个数字的唯一正当理由：发现了"画像陈旧导致推荐明显偏离"的实证。
 * 放宽的代价仅为画像聚类更新变慢，不会造成错误推荐。
 */
export const BUILD_MAX_AGE_HOURS = 24
/** 新用户首建：无画像用户行为事件达到该值时，/api/inspirations 自动触发首次 full build */
export const FIRST_BUILD_MIN_EVENTS = 5
export const INTERPRET_BATCH_SIZE = 20
export const INTERPRET_WINDOW_DAYS = 90

// ── P0 数据闭环：重建触发判定（rebuildTrigger 消费）──
//
// 旧触发面的两个断点，是"新增/删除作品后推荐没变化"的直接根因：
//   1) 触发判定只写在 /api/inspirations 里，Feed 端点（用户真正长时间停留的地方）
//      完全没有重建判定——它只有"库存 ≤8"这一个补货触发点；
//   2) 唯一生效的脏事件阈值是 5，而一篇作品只产生 1~3 条事件（work_generate
//      + 可能的 finalize），日常创作永远够不着；画像 1h 过期又是远水。
//
// 因此给"作品级行为"开一条独立低阈值通道：1 条即触发。用户亲手产出/亲手删除
// 的内容是最高价值信号，它必须比"又浏览了两次"更快地反映到推荐队列。
export const REBUILD_HIGH_SIGNAL_TYPES: ReadonlyArray<CreatorEventType> = [
  'work_generate',
  'work_finalize',
  'work_unfinalize',
  'work_delete',
  'recommend_adopt',
]
/** 高信号事件触发重建的最小条数（1 = 一篇作品的增删立即反映到队列） */
export const REBUILD_HIGH_SIGNAL_MIN = 1

/**
 * 可作为「新作品种子」的事件类型。
 * 刻意排除 work_delete：删除是减分信号，若拿被删主题去当探索种子，
 * 等于用户刚表示不要、系统反而生成更多同主题推荐卡。
 */
export const REBUILD_SEED_EVENT_TYPES: ReadonlyArray<CreatorEventType> = ['work_generate', 'recommend_adopt']
/** 新作品种子最多取几条主题（控制 S4 prompt 长度与 LLM 成本） */
export const REBUILD_FRESH_TOPIC_LIMIT = 3

/**
 * build 内「新作品种子」最多取几条（与 REBUILD_FRESH_TOPIC_LIMIT 同量级，独立命名
 * 是因为两者的语义不同：后者是 rebuildTrigger 取"上次 build 之后新增"的主题，
 * 前者是 builder 取"被 CLUSTER_MIN_MEMBERS 挡在画像之外"的最新作品主题）。
 *
 * 存在理由：一篇全新方向的作品会形成单成员簇，被 CLUSTER_MIN_MEMBERS=2 滤掉，
 * 既不进画像、也不进 buildExplorationSeeds 的簇种子 → 用户写完一篇新方向，
 * 推荐队列纹丝不动（"新增作品不影响推荐"的直接根因）。这里把它捞回来当探索种子。
 */
export const BUILD_FRESH_WORK_SEED_LIMIT = 3

/**
 * dashboard 首屏最多前置几张「上次 build 之后新增」的卡。
 * 与 Feed 的 FEED_FRESH_INJECT_MAX 同口径：补货只往队尾追加，而读卡按 score 取 Top N，
 * 新卡大概率掉出首屏 —— 闭环在体感上等于没发生。
 */
export const DASHBOARD_FRESH_INJECT_MAX = 2

/**
 * ✕ 不感兴趣的原因码（白名单，服务端落 creator_events.payload.reason_code）。
 * 只有 reason_code 没有 reasonFactor——它是 Taste Model 的原料，不参与兴趣权重计算。
 */
export const DISMISS_REASON_CODES = [
  'not_my_direction',
  'already_created',
  'not_interesting',
  'too_hard',
  'not_my_voice',
] as const
export type DismissReasonCode = (typeof DISMISS_REASON_CODES)[number]
/** 触发判定时扫描的最近事件条数上限（倒序取最新，够判定用，避免全表扫） */
export const REBUILD_SCAN_EVENT_LIMIT = 500

// ── WF12 MVP：Feed 轻量补货（refill）与热点补位 ──
//
// build 与 refill 的分工，是"无限流不断供"的核心：
//   runBuild = 理解用户（拉事件 → 补 embedding → 原因解释 → 聚类 → 分层 → 趋势
//              → 装配画像 → 造卡），3 次 LLM，耗时 20-150s。
//
//              关于队列：**runBuild 不再"第一步清空"**，这条描述是旧实现留下的，
//              已与代码不符——现在 builder 走的是「先落新卡 → 再 supersedeExceptBuild
//              (build_id) 清旧卡」的原子切换，重建的 20-150s 里旧卡照常服务，
//              用户不会撞到"队列空"降级。
//              仍然存在的代价是**游标失效**：旧卡被整批换成新卡后，Feed 手里
//              的 cursor 指向的行已不在 active 队列里，getFeedPage 会从头开始翻
//              （feedRepo 对此有明确处理），表现为"刷着刷着回到前面几张"。
//              这正是 Feed 端点坚持只走 refill、绝不直接 runBuild 的原因——
//              refill 是追加，不动旧卡，游标连续。
//   refill   = 只造卡（复用上次 build 落库的簇 → 候选生成 → 打分 → 追加队列），
//              1 次 LLM，秒级完成，且不清空队列，翻页体验连续。
//
// 因此 Feed 库存不足时补货走 refill，只有 refill 不可行（无画像/无簇）时才回退 runBuild。
// 这些是调度参数而非评分权重，不改变 scoreCandidate 口径，故不触发 RULE_VERSION 升版。

/**
 * 候选 embedding 与簇质心的最小余弦——低于此视为"不属于任何已知方向"。
 *
 * 实测标定（bge-m3 @1024，25 张存量卡 vs 各自活跃簇）：
 *   中位数 0.49~0.63，p25 0.45~0.61，max 0.80。
 * 取 0.5 时命中率 48%~96%（取决于用户簇的覆盖广度）。
 *
 * 调低会把弱相关的卡硬塞进某个簇，凭空造出「你在「X」关注但还没写过」的假事实；
 * 调高则退回"全部无簇"，兴趣画像彻底不参与排序。0.5 是这两端的平衡点。
 */
export const CLUSTER_MATCH_MIN_SIMILARITY = 0.5

// ── 曝光—反馈闭环：让推荐从真实互动里学 ──
//
// 背景（生产实锤）：三个用户累计 297 次曝光，只换来 6 次点击（CTR 0.5%~20%），
// 却点了 16 次 ✕。而在加上下面的闭环之前，排序侧对这些信号是**零消费**的——
// recommend_impression 权重 0（stats_only）、recommend_click 仅 0.15 且只间接
// 参与聚类。结果：一张被展示 10 次、一次没点过的卡，分和被展示 0 次的新卡
// 完全一样，队列永远不会轮换，体感就是"刷来刷去都是这几张"。
//
// 闭环分两层，口径不同，不要合并：
//   ① 单卡曝光疲劳 —— 这张卡"看腻了没有"，只看它自己
//   ② 簇级互动率   —— 这个方向"用户买不买账"，会推广到该方向的新卡
// ① 负责轮换，② 负责学习。缺 ① 队列僵化，缺 ② 只能学会嫌弃具体某张卡。

/** 回看多久的曝光/点击。卡 14 天过期，30 天足以覆盖它的一生 */
export const ENGAGEMENT_WINDOW_DAYS = 30

/** 前几次曝光不罚：新卡需要机会，不能一出生就按历史均值打折 */
export const FATIGUE_FREE_IMPRESSIONS = 2

/** 疲劳地板。降到 0.65 为止，保证"看腻了"也绝不等于"消失" */
export const FATIGUE_FLOOR = 0.65

/** 疲劳衰减速度（次）。越大越温和 */
export const FATIGUE_DECAY_IMPRESSIONS = 5

/** 簇级互动率的最小样本。低于此不学——3 次曝光没点击不能判一个方向死刑 */
export const CTR_MIN_SAMPLE = 8

/**
 * 互动率的贝叶斯先验（拉普拉斯平滑）：伪点击 α / 伪未点击 β。
 * 先验均值 = α/(α+β) = 0.05，即"一张值得展示的卡大约 5% 概率被点"。
 * 平滑的意义：1 次点击 / 3 次曝光 不能等同于 33% 命中率。
 */
export const CTR_PRIOR_ALPHA = 1
export const CTR_PRIOR_BETA = 19

/** 簇级乘子的钳制区间。宁可学得慢，也不能一次把某个方向打进冷宫 */
export const CTR_FACTOR_FLOOR = 0.7
export const CTR_FACTOR_CAP = 1.2

/**
 * dashboard 端点每次读多少张 active 卡参与在线重排。
 * 不是 Magic number 的例外——它是上限而非阈值：队列通常 20~30 张，
 * 设 60 保证"全读"，再往上没有收益只有传输成本。
 */
export const DASHBOARD_QUEUE_SCAN_LIMIT = 60

/** 同一用户两次 refill 的最小间隔（成本闸门：与请求频率解耦） */
export const REFILL_MIN_INTERVAL_MS = 5 * 60_000
/** 单次 refill 的 S4 探索生成条数（小于 build 的 24，控制单次 LLM 成本） */
export const REFILL_BATCH_SIZE = 12
/** refill 卡中配 AI 理由的最高分条数（其余模板降级，不额外烧 LLM） */
export const REFILL_REASON_TOP_N = 6
/** refill 新卡与在库卡的标题去重阈值（字符 bigram Jaccard） */
export const REFILL_TEXT_DEDUPE_THRESHOLD = 0.7
/** 在途锁 TTL：超时未完成视为进程冻结遗留，自动释放 */
export const REFILL_LOCK_TTL_MS = 3 * 60_000
/** refill 构造 AI 理由所需的真实行为事实回看窗口（天） */
export const REFILL_FACTS_WINDOW_DAYS = 90

/** 每页 Feed 最多补入的全局热点卡数（仅在个性化卡不足 limit 时补位，不挤占个性化） */
export const FEED_TRENDING_INJECT_MAX = 2

/**
 * Feed 首屏最多前置几张「本轮新作品驱动生成」的卡。
 *
 * 为什么需要前置：补货只往队列尾部追加，而 Feed 按 score 排序取首页，
 * 新卡大概率掉出首屏——用户写完一篇再回 Feed，看到的仍是同一批旧卡，
 * 闭环在体感上等于没发生。首屏前置这几张，翻页仍走原游标，不受影响。
 */
export const FEED_FRESH_INJECT_MAX = 3

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
