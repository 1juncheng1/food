// ============================================================
// Content Intelligence Data Layer —— 统一类型定义
//
// 设计红线（详见架构设计文档/会话记录）：
//   1. excerpt ≤300 字，永不存全文（不做内容复制，版权红线）
//   2. 指标字段 null 语义：null = 该源拿不到；永不为 0/估算值冒充
//   3. AI 分析字段与原始字段分离：ai_analysis 可整块为 null（未富化）
//   4. 所有平台数据统一进 CIItem，消费方（市场分析/灵感分析/策略块）零感知平台差异
// ============================================================

/** 数据来源平台（扩展时只加枚举值） */
export type CIPlatform = 'web_search' | 'news' | 'bilibili' | 'douyin' | 'zhihu'

/** 各数据源能力声明——消费者据此处理字段缺失，不假装数据存在 */
export interface CISourceCapabilities {
  /** 该源能提供的真实指标；web/news 源为空数组 */
  metrics: Array<'play' | 'like' | 'comment' | 'collect'>
  /** 能否拿到准确发布时间 */
  publishedAt: boolean
  /** 能否拿到评论文本（决定 ai_analysis.user_feedback 是否可能有真值） */
  comments: boolean
}

/** 统一内容条目（Content Intelligence Schema） */
export interface CIItem {
  // ── 基础信息 ──
  platform: CIPlatform
  /** 平台内容唯一标识（URL 哈希），(platform, external_id) 唯一 */
  external_id: string
  url: string
  title: string
  /** ≤300 字摘要，禁止存全文 */
  excerpt: string
  author: string
  /** 能力不支持时为 null，不编造 */
  published_at: string | null

  // ── 数据指标（能力门控：无数据为 null，永不为 0 假装真实）──
  metrics: {
    play_count: number | null
    like_count: number | null
    comment_count: number | null
    collect_count: number | null
  }

  // ── 内容信息 ──
  content_info: {
    /** 来源查询主题 */
    topic: string
    keywords: string[]
    /** webpage / news（web/news 源）；video / answer / post 为未来平台源预留 */
    content_type: string
  }

  // ── AI 分析字段（批量富化产出；未富化为 null）──
  ai_analysis: {
    opening_structure: string | null
    core_viewpoint: string | null
    emotion_type: string | null
    narrative_structure: string | null
    /** 仅 capabilities.comments=true 的源可能有真值 */
    user_feedback: string | null
    reference_value: string | null
  } | null

  fetched_at: string
  /** TTL 到期后不作为分析依据 */
  expires_at: string
}

/** 查询描述（平台无关） */
export interface CIQuery {
  topic: string
  /** 内容领域（来自灵感分析 content_domain），辅助搜索词构造 */
  content_domain?: string
  maxItems?: number
}

/** 统一数据源适配器接口——所有平台实现它，消费方零感知 */
export interface CISourceAdapter {
  id: CIPlatform
  capabilities: CISourceCapabilities
  /** 搜索返回统一格式；失败返回空数组 + 原因，不抛异常中断扇出 */
  search(query: CIQuery, limit: number): Promise<{ items: CIItem[]; error?: string }>
  /** WF8：stub 适配器标记（在册但未接入真实数据；不算真实数据源） */
  stub?: boolean
}

// ── WF8：外部热点趋势标准协议（阶段8预留） ──────────────────────
// 未来接入抖音/B站/知乎等平台热点时，外部数据一律先归一化为该结构，
// 再经 externalTrendToCIItem 进 ci_items 管线——消费方零感知平台差异。

export interface ExternalTrendData {
  platform: CIPlatform
  /** 平台内容唯一标识（与 CIItem.external_id 对齐，(platform, external_id) 唯一） */
  externalId: string
  url: string
  title: string
  /** ≤300 字摘要（版权红线：永不存全文） */
  excerpt: string
  /** 平台侧标签（可选；WF4 四维标签接入后可携带） */
  dimensions?: string[]
  /** 热度分（0-1 归一）；拿不到真值为 null，红线"永不为 0/估算值冒充" */
  trendScore: number | null
  fetchedAt: string
}

// ── 共享工具 ────────────────────────────────────────────────

/** 截断到指定长度（超长加省略号） */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** 清洗为安全文本：非字符串返回空串 */
export function safeText(v: unknown, max = 300): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}
