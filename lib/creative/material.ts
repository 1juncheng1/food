// Material —— 素材库 2.0 数据层类型定义
//
// 设计原则（Phase 0 审计 + Phase 1 plan 确认）：
//   1. 复用 scripts 表，Material = Script + 新 7 字段（不新建 materials 表）
//   2. material_type 9 种枚举，用 text 存储靠应用层校验（不加 DB CHECK 约束）
//   3. claims jsonb 结构 Phase 3 Retrieval Service 定义，本阶段留空 jsonb
//   4. MaterialUsage 记录推荐→选择→拒绝→使用四态，为 Phase 5 推荐训练闭环
//   5. MaterialGroup 是用户管理方式，不是 AI 唯一检索依据
//
// 与 KnowledgeItem 的关系：
//   - KnowledgeItem（knowledgeItem.ts）是 AI 理解的完整 6 维结构，存 scripts.knowledge jsonb
//   - Material 的 ai_summary/related_topics 是从 knowledge 拆出的冗余存储，便于检索
//   - 两者并存：knowledge 是原始 AI 理解，Material 新字段是检索优化层
// ============================================================

// ── 1. 素材类型枚举 ───────────────────────────────────────

/**
 * 素材类型 9 种枚举。
 * 不同类型采用不同使用约束（Phase 4 接入 AI 创作时注入 Prompt）：
 *   - 观点：可展开重组，但不能改变核心观点
 *   - 事实/数据：可组织表达，但不能无依据修改或编造
 *   - 案例：可重构叙事，但不能虚构原素材不存在的信息
 *   - 金句：优先保留原表达，再围绕其展开
 *   - 经历：视为用户内容资产，不得擅自变成客观事实
 */
export const MATERIAL_TYPES = [
  '观点',
  '事实',
  '数据',
  '案例',
  '金句',
  '经历',
  '观察',
  '灵感',
  '其他',
] as const

export type MaterialType = (typeof MATERIAL_TYPES)[number]

/**
 * 素材来源（Phase 2 UI 添加素材时选择）。
 * 不加 DB 约束，应用层校验；legacy 素材 source = null。
 */
export type MaterialSource = '手输' | '上传' | '外部链接' | 'AI生成'

// ── 1.1 素材类型使用规则 ──────────────────────────────────

/**
 * 9 种素材类型对应的使用规则 + Tailwind 色系。
 * label：UI 展示名（与枚举字面量一致）
 * usageRule：创作时使用该类型素材的约束（Phase 4 注入 Prompt；Phase 2 在 AI 理解抽屉展示）
 * color：Tailwind 色系名（badge 配色用）
 */
export const MATERIAL_TYPE_RULES: Record<
  MaterialType,
  { label: string; usageRule: string; color: string }
> = {
  观点: {
    label: '观点',
    usageRule: '可展开重组，但不能改变核心观点',
    color: 'indigo',
  },
  事实: {
    label: '事实',
    usageRule: '可组织表达，但不能无依据修改或编造',
    color: 'emerald',
  },
  数据: {
    label: '数据',
    usageRule: '可组织表达，但不能无依据修改或编造',
    color: 'amber',
  },
  案例: {
    label: '案例',
    usageRule: '可重构叙事，但不能虚构原素材不存在的信息',
    color: 'rose',
  },
  金句: {
    label: '金句',
    usageRule: '优先保留原表达，再围绕其展开',
    color: 'cyan',
  },
  经历: {
    label: '经历',
    usageRule: '视为用户内容资产，不得擅自变成客观事实',
    color: 'violet',
  },
  观察: {
    label: '观察',
    usageRule: '可展开分析，但保留原观察视角',
    color: 'sky',
  },
  灵感: {
    label: '灵感',
    usageRule: '可自由发散，但标注为灵感非事实',
    color: 'orange',
  },
  其他: {
    label: '其他',
    usageRule: '按上下文灵活使用',
    color: 'slate',
  },
}

// ── 1.2 素材主张（claims）结构 ──
//
// 规范类型已统一到 knowledgeItem.ts 的 KnowledgeClaim，此处不再重复定义。
// 原 MaterialClaim（kind/text/source/note）从未被任何代码引用；继续保留两套
// 结构会让跨素材聚合不得不同时兼容两种形状，因此合并为一。
// 本文件只做 re-export，避免下游 import 路径分歧。

export type { KnowledgeClaim } from '@/lib/creative/knowledgeItem'

// ── 2. Material 类型（复用 scripts 表） ───────────────────

/**
 * 素材单元。对应 scripts 表一行。
 * 复用现有字段 + Phase 1 新增 7 字段。
 */
export interface Material {
  // ── 现有字段（scripts 表原有）──
  id: string
  user_id: string
  content: string // 用户原文（核心资产，不可被 AI 标签替代）
  type: string | null // 媒体类型：'text' / 'image'
  file_url: string | null // 图片地址（type=image 时有值）
  category: string | null // 用户视角粗分类（保留兼容，不作为主分类）
  embedding: number[] | string | null // bge-m3 1024 维向量
  created_at: string
  knowledge: KnowledgeItem | null // AI 理解的完整 6 维结构（Phase 0 已有）

  // ── Phase 1 新增 7 字段 ──
  group_id: string | null // 所属分组（material_groups.id）
  material_type: MaterialType | null // 9 种枚举之一（Phase 1 从 knowledge.content_type 映射）
  source: MaterialSource | string | null // 素材来源
  ai_summary: string | null // 从 knowledge.meaning+context 拆出的摘要（检索冗余层）
  related_topics: string[] | null // 从 knowledge.content_tags 拆出的相关主题
  /**
   * 素材中的主张（scripts.claims 列的检索冗余层，对应 ai_summary/related_topics 的定位）。
   * 真源是 knowledge.claims：AI 抽取后写在 knowledge jsonb 内部，随 knowledge 一并读写。
   * 本字段暂不写入 —— 等 Phase 2 需要跨素材 SQL 聚合时再物化，避免双份数据漂移。
   */
  claims: KnowledgeClaim[] | null
  updated_at: string // 编辑时间戳
}

// ── 3. MaterialGroup 类型 ─────────────────────────────────

/**
 * 素材分组。用户自由建立（AI观察/商业/电影/创业/职场/我的观点...）。
 * 分组是用户管理方式，不是 AI 唯一检索依据。
 */
export interface MaterialGroup {
  id: string
  user_id: string
  name: string
  created_at: string
  updated_at: string
}

// ── 4. MaterialUsage 类型 ────────────────────────────────

/**
 * 素材使用记录。记录推荐→选择→拒绝→使用四态。
 * 为 Phase 5 推荐系统训练提供闭环数据。
 *
 * 状态机：
 *   AI 推荐 (suggested_by_ai=true) → 用户选择 (selected_by_user=true) → 实际使用 (actually_used=true)
 *   AI 推荐 (suggested_by_ai=true) → 用户拒绝 (selected_by_user=false) → 终态
 *   用户手动选择 (suggested_by_ai=false, selected_by_user=true) → 实际使用 (actually_used=true)
 */
export interface MaterialUsage {
  id: string
  user_id: string
  material_id: string // references scripts.id
  work_id: string | null // references generation_history.id（text 类型，前端生成 UUID）
  suggested_by_ai: boolean // AI 是否推荐过
  selected_by_user: boolean // 用户是否选择（true=选择，false=拒绝）
  actually_used: boolean // 是否实际进入生成上下文（Phase 4 prompt-optimizer 写入）
  created_at: string
}

// ── 5. 辅助类型 ──────────────────────────────────────────

/**
 * Material Retrieval Service 输出（Phase 3 实现）。
 * 当前定义类型，Phase 1 不实现服务。
 */
export interface MaterialRetrievalResult {
  materialId: string
  content: string
  materialType: MaterialType | null
  relevanceScore: number // 0-1
  relevanceReason: string // "为什么相关"的人类可读说明
}

/**
 * Material Retrieval Service 输入（Phase 3 实现）。
 */
export interface MaterialRetrievalInput {
  userId: string
  currentTopic: string
  currentIntent?: string // 创作意图（观点展开/事实支撑/案例引用/...）
  currentContext?: string // 当前创作上下文（保留字段；永不参与向量构造）
  selectedMaterialIds?: string[] // 用户主动选择（优先级最高）
}

/**
 * 相关性理由生成模式。
 * - template：确定性模板拼装（0 LLM、0 延迟，prompt-optimizer 内部固定走此模式）
 * - llm：一次 DeepSeek 批量调用生成更自然的理由（Phase 4 素材选择步骤显式 opt-in）
 */
export type RelevanceReasonMode = 'template' | 'llm'

/**
 * 素材召回的可观测元信息。
 * - degraded：null=正常；'embedding'=嵌入失败仅返回 selected/空；'llm_reason'=LLM 理由失败已整体回退模板
 * - recalledCandidateCount：通过硬阈值、去重后、截取 autoLimit 前的自动召回候选数
 * - missingSelectedIds：selectedMaterialIds 中被 RLS 静默丢弃（不存在/跨用户）的 id
 */
export interface MaterialRetrievalMeta {
  degraded: null | 'embedding' | 'llm_reason'
  recalledCandidateCount: number
  missingSelectedIds: string[]
  reasonMode: RelevanceReasonMode
  threshold: number
}

// ── 6. 从 knowledgeItem.ts 引入 KnowledgeItem（避免循环依赖，type-only import）──

import type { KnowledgeClaim, KnowledgeItem } from '@/lib/creative/knowledgeItem'

// ── 7. 创作时素材注解（根基 + 手打标签/备注）──────────────
//
// 产品语义：
//   - 用户在素材选择步骤可把 1 条素材指定为"创作根基"（本篇权威事实来源），
//     其余选中素材仍为平级辅助参考
//   - 标签/备注仅本次生成生效，随请求传给 prompt-optimizer，绝不写回素材库
//     （临时注解先验证真实使用频率，高频标签未来再沉淀为素材库永久字段）

/** 素材在本次创作中的角色：根基（单条）/ 辅助参考 */
export type MaterialRole = 'foundation' | 'reference'

/** 预设快捷标签（服务端按此白名单校验，禁止客户端自创值进 prompt） */
export const MATERIAL_ANNOTATION_TAGS = [
  '事实依据',
  '必须提及',
  '风格参考',
  '避免照搬',
] as const

export type MaterialAnnotationTag = (typeof MATERIAL_ANNOTATION_TAGS)[number]

/** 单条素材的本次创作注解 */
export interface MaterialAnnotation {
  materialId: string
  role: MaterialRole
  /** 白名单标签（≤4 个，去重） */
  tags: MaterialAnnotationTag[]
  /** 自由备注（≤200 字），如"银河叙事是我本人的产品，定位是灵感直通车" */
  note: string
}

/** 注解条数上限（与 MAX_SELECTED 对齐） */
export const MAX_MATERIAL_ANNOTATIONS = 10
/** 单条素材标签上限 */
export const MAX_ANNOTATION_TAGS = 4
/** 自由备注长度上限 */
export const MAX_ANNOTATION_NOTE_LEN = 200

/**
 * 服务端白名单清洗客户端传入的素材注解（防注入 prompt 的自由文本/伪造角色）。
 * 规则：
 *   1. 非数组/超量 → 截断/空；materialId 去重保序（先出现者胜）
 *   2. role 只认 foundation/reference，非法值降级 reference
 *   3. 最多保留 1 个 foundation（先出现者胜，其余降级 reference）
 *   4. tags 仅保留白名单值并去重截断；note 截断 200 字
 */
export function sanitizeMaterialAnnotations(raw: unknown): MaterialAnnotation[] {
  if (!Array.isArray(raw)) return []
  const out: MaterialAnnotation[] = []
  const seen = new Set<string>()
  let foundationTaken = false

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const materialId = typeof o.materialId === 'string' ? o.materialId.trim() : ''
    if (!materialId || seen.has(materialId)) continue
    seen.add(materialId)

    let role: MaterialRole = o.role === 'foundation' ? 'foundation' : 'reference'
    if (role === 'foundation') {
      if (foundationTaken) role = 'reference'
      else foundationTaken = true
    }

    const tagWhitelist = MATERIAL_ANNOTATION_TAGS as readonly string[]
    const tags = Array.isArray(o.tags)
      ? Array.from(
          new Set(
            o.tags.filter(
              (t): t is MaterialAnnotationTag =>
                typeof t === 'string' && tagWhitelist.includes(t)
            )
          )
        ).slice(0, MAX_ANNOTATION_TAGS)
      : []

    const note =
      typeof o.note === 'string' ? o.note.trim().slice(0, MAX_ANNOTATION_NOTE_LEN) : ''

    out.push({ materialId, role, tags, note })
    if (out.length >= MAX_MATERIAL_ANNOTATIONS) break
  }

  return out
}
