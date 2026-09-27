import { NextResponse } from 'next/server'
import { withAiDeadline } from '@/lib/aiDeadline'
import { IDENTITY_TEMPLATES } from '@/lib/identityTemplates'
import { authenticateRequest, type AuthResult } from '@/lib/apiAuth'
import { callDeepSeekChat, isLlmNetworkError, llmUserMessage, type ChatMessage } from '@/lib/llm'
import { addUsage, INSUFFICIENT_POINTS_MESSAGE, ZERO_USAGE } from '@/lib/balance'
// Phase 4：AI 计费改为「调用前预扣 + 调用后按真实 token 结算」
import { refundAiCost, reserveAiCost, settleAiCost } from '@/lib/aiCost'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveTargetLanguage } from '@/lib/languageConsistency'
import {
  normalizeBlueprint,
  formatBlueprintForPrompt,
  type CreativeBlueprint,
} from '@/lib/creative/blueprint'
import {
  NEXT_ACTION_META,
  parseDiagnosis,
  type CreativeDiagnosis,
  type NextActionKey,
} from '@/lib/creative/diagnosis'
import { parseStyleDimensions, recordDirectionSignal } from '@/lib/creative/styleLearning'
import { buildCreatorContextBlocks } from '@/lib/creative/creatorContext'
import { type PersonalizationEvidence } from '@/lib/creative/creatorModel'
import { type DeclarationTrait } from '@/lib/creative/creatorDeclaration'
import {
  resolveMode,
  planPersonalization,
  buildCreatorIdentity,
  type CreationMode,
  type TaskMode,
} from '@/lib/creative/personalization'
import { fetchCreatorStyleProfile } from '@/lib/creative/styleProfileRepo'
import { cosineSimilarity } from '@/lib/styleVector'
import {
  sanitizeCharacterInput,
  formatCharactersForPrompt,
} from '@/lib/characters'
import {
  normalizeWorkTags,
  type WorkTags,
} from '@/lib/creative/workAnalysis'
import type { UsageTag } from '@/lib/creative/knowledgeItem'
import { normalizeInspirationAnalysis } from '@/lib/creative/inspirationAnalyzer'
import { trackEvent } from '@/lib/creative/interest/eventTracker'
import { runBuild } from '@/lib/creative/interest/builder'
import { afterResponse } from '@/lib/afterResponse'
import { retrieveMaterials, MAX_INJECT_TOTAL } from '@/lib/material/retrieval'
import {
  buildKnowledgeInjection,
  summarizeInjectedUnits,
} from '@/lib/creative/knowledgeInject'
import type { CreatorKnowledgeUnit } from '@/lib/creative/knowledgeUnit'
import type { InjectedUnitSummary } from '@/lib/creative/knowledgeInject'
import {
  sanitizeMaterialAnnotations,
  MATERIAL_TYPE_RULES,
  type MaterialAnnotation,
  type MaterialRetrievalResult,
  type MaterialType,
} from '@/lib/creative/material'
import { inferUsageFilter } from '@/lib/material/usageFilter'
import {
  markSelectedByUser,
  markActuallyUsed,
} from '@/lib/material/usageWriter'
import { rateLimit } from '@/lib/rateLimit'

export const maxDuration = 60

interface RequestBody {
  topic?: unknown
  templateId?: unknown
  customIdentity?: unknown
  style?: unknown
  wordCount?: unknown
  category?: unknown // 内容类型（固定选项值或"自定义类型"）
  customCategory?: unknown // 选自定义类型时用户填写的品类文本
  memory?: unknown // 前端聚合好的用户历史风格记忆（localStorage 无法由后端读取，随请求传入）
  generationId?: unknown // 前端生成的作品 id（登录时用它作为 generation_history 主键，保持两边一致）
  blueprint?: unknown // 创作进化系统阶段 2：已确认的创作蓝图（登录用户两阶段生成时传入）
  projectId?: unknown // 创作进化系统阶段 3：传入 = 在该项目下新增版本；不传且有蓝图 = 新建项目并生成 V1
  // 阶段 5：定向迭代（点诊断卡方向）。传入后忽略 topic/身份等表单字段，
  // 全部从 fromVersionId 对应版本继承，按 direction 重写下一版
  improve?: unknown
  // Creator Mode：'inspiration' 灵感模式（剥离全部隐性个人数据）/ 'creator' 我的模式
  mode?: unknown
  // 旧版个人化开关（mode 缺省时兼容映射；新客户端请传 mode）
  useCreatorModel?: unknown
  // 阶段四：登场角色快照数组（最大 3 个，服务端经 sanitizeCharacterInput 清洗）
  characters?: unknown
  /**
   * AI 灵感分析：用户在 insight 态确认后的 InspirationAnalysis。
   * 透传到 generation_history.inspiration_context jsonb 落库。
   * 数据沉淀用于未来个性化灵感推荐与创作者偏好学习。
   * 不传时为 null（老链路不受影响）。
   */
  inspirationContext?: unknown
  // Material Library 2.0 Phase 3：用户在素材选择步骤主动指定的素材 id（可选预留）。
  // 旧客户端不传 = 纯自动召回，行为保持；Phase 4 前端才会传值。
  selectedMaterialIds?: unknown
  /**
   * 素材创作注解（根基 role=foundation + 临时标签/备注，仅本次生成生效，不落库）。
   * 服务端经 sanitizeMaterialAnnotations 白名单清洗；存在时其 materialId
   * 覆盖 selectedMaterialIds。
   */
  materialAnnotations?: unknown
}

const VALID_DIRECTIONS: readonly NextActionKey[] = [
  'hit',
  'style',
  'emotion',
  'depth',
  'video',
  'script',
  'custom',
]

/** 安全取字符串字段并限制长度，防止 prompt 被超长数据撑爆 */
function str(v: unknown, maxLen: number): string {
  return typeof v === 'string' ? v.trim().slice(0, maxLen) : ''
}

/**
 * 解析 Supabase 返回的向量值（可能是数组或字符串 "[0.1,0.2,...]"）。
 */
function parseVector(v: unknown): number[] | null {
  if (Array.isArray(v) && v.length > 0) {
    return v as number[]
  }
  if (typeof v === 'string' && v.length > 2) {
    try {
      const arr = JSON.parse(v)
      if (Array.isArray(arr) && arr.length > 0) return arr as number[]
    } catch {
      const trimmed = v.replace(/^\[|\]$/g, '')
      const parts = trimmed.split(',').map(Number).filter(Number.isFinite)
      if (parts.length > 0) return parts
    }
  }
  return null
}

/**
 * 调用 SiliconFlow bge-m3 模型生成文本的嵌入向量（1024 维）。
 * 与 /api/scripts 保持一致，复用同一个嵌入服务。
 */
async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const res = await fetch('https://api.siliconflow.cn/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'BAAI/bge-m3',
        input: text.slice(0, 8000), // 截断防止超出嵌入模型上限
      }),
    })
    if (!res.ok) {
      console.error('嵌入向量生成失败:', await res.text())
      return null
    }
    const data = await res.json()
    const embedding = data?.data?.[0]?.embedding
    return Array.isArray(embedding) ? embedding : null
  } catch (e) {
    console.error('嵌入向量生成异常:', e)
    return null
  }
}

/** 风格卡数据结构（仅取需要用到的字段） */
interface StyleProfile {
  tone_tags: string[]
  pace_preference: string
  common_opening: string
  avg_length: number
  style_vector?: number[] | string | null
}

/**
 * 强制鉴权：只有登录用户才能生成文案。
 * 游客请求直接返回 401，不进入生成流程。
 */
/**
 * 鉴权统一走 lib/apiAuth：无 token → 401「请先登录后再生成文案」；
 * 网络故障 → 503「网络异常」（已登录用户不得踢）；凭证失效 → 401「登录已过期」。
 */
async function authenticateRequired(req: Request): Promise<AuthResult> {
  return authenticateRequest(req, '请先登录后再生成文案')
}

// 下面的 60 必须等于本文件的 maxDuration。
// 本路由串行跑多段 LLM（工作分析 3 次重试 + 主提示词生成 55s），
// 各拿一份预算会远超 maxDuration → 被平台硬杀、预扣退不回。见 lib/aiDeadline.ts
async function handlePost(req: Request) {
  // ── AI 计费状态（Phase 4）─────────────────────────────────────
  // 刻意声明在 try **之外**：任何异常分支都要能读到它，把预扣退回去。
  //   预扣成功 → 生成 → 结算（多退少补）
  //   中途任何失败 → 全额退，绝不让"没生成出东西还扣了积分"
  let billing: {
    supabase: SupabaseClient
    userId: string
    refId: string
    reserved: number
  } | null = null
  let settled = false

  try {
    const body = (await req.json()) as RequestBody

    // 强制鉴权：游客不可生成文案，只有登录用户才能使用
    const auth = await authenticateRequired(req)
    if (!auth.ok) return auth.response

    // ── 限流：5 次/60s/用户（Prompt-optimizer 是重成本 LLM 路由）──
    const rl = rateLimit(
      `prompt-optimizer:${auth.userId}`,
      5,
      60_000
    )
    if (!rl.ok) {
      return NextResponse.json(
        { error: '生成过于频繁，请稍后再试' },
        {
          status: 429,
          headers: { 'Retry-After': String(rl.retryAfterSec) },
        }
      )
    }

    // ── 调用前预扣：余额不足 → 绝不发起付费 LLM 调用（需求 §18）──
    //
    // 与旧逻辑的本质差别：以前只是「查一下够不够最低扣费」，查完到真正扣费
    // 之间隔着两次 LLM 网络往返；并发请求会同时通过检查，最后谁也扣不动。
    // 现在把「扣」提前到「检查」的同一时刻（行锁内原子完成），
    // 生成完再按真实 token 用量多退少补（settleAiCost）。
    const billingRefId = crypto.randomUUID()
    const reserved = await reserveAiCost({
      supabase: auth.supabase,
      userId: auth.userId,
      ability: 'generation',
      refId: billingRefId,
      description: '正文生成预扣',
    })

    if (!reserved.ok) {
      // fail-open 只在**读不到**时生效：数据库抖动不该锁死创作。
      // 但明确判定为余额不足时，必须拦住——否则成本就是平台自己承担。
      if (reserved.code === 'insufficient_balance') {
        return NextResponse.json(
          {
            error: INSUFFICIENT_POINTS_MESSAGE,
            code: 'insufficient_balance',
            balance: reserved.balance ?? 0,
          },
          { status: 402 }
        )
      }
      console.warn('[aiCost] 预扣失败（按放行处理）:', reserved.code)
    } else {
      billing = {
        supabase: auth.supabase,
        userId: auth.userId,
        refId: billingRefId,
        reserved: reserved.reserved,
      }
    }

    // usage_filter 推断（inferUsageFilter）已在 Phase 3 搬迁至
    // @/lib/material/usageFilter，在下方素材召回段使用。
    // 推断优先级：improve prevUsageTags > blueprint.usage_tag > content_type 映射 > null。

    // ── 阶段 5：定向迭代上下文（仅登录；从被迭代版本继承全部创作参数）──
    // 解析失败时 improveCtx=null，请求按普通生成处理（后续 topic 校验会拦住缺参情况）
    let improveCtx: {
      direction: NextActionKey
      instruction: string // custom 方向时用户的一句话修改指令；其他方向为 ''
      userFeedback: string // 阶段 4：用户原始反馈文本（V2+ 溯源用；空串表示非反馈驱动迭代）
      projectId: string
      topic: string
      identityLabel: string
      style: string
      category: string
      wordCount: number
      blueprint: CreativeBlueprint | null
      analysis: CreativeDiagnosis | null
      prevText: string
      prevUsageTags: UsageTag[] // 阶段 5：上一版 work_tags.usage_tags，用于检索时的 usage_filter
      promptText: string
    } | null = null

    const improveRaw =
      typeof body.improve === 'object' && body.improve !== null
        ? (body.improve as Record<string, unknown>)
        : null
    const improveDirection = str(improveRaw?.direction, 20) as NextActionKey | ''
    const fromVersionId = str(improveRaw?.fromVersionId, 200)
    // 阶段 4 Work Agent：instruction 现在携带 formatFeedbackForPrompt 输出的完整优化蓝图
    // （含用户反馈原文 + 修改点 + 优化蓝图），放宽到 2000 字
    const improveInstruction = str(improveRaw?.instruction, 2000)
    // 阶段 4 Work Agent：userFeedback 是用户原始反馈文本（与 instruction 不同：
    // instruction 是 AI 格式化后的优化蓝图，userFeedback 是用户说的原话）
    // 用于 generation_history.user_feedback 字段溯源（V2+ 才有值，V1 为 null）
    const userFeedbackText = str(improveRaw?.userFeedback, 2000)
    if (improveRaw && (!auth || !fromVersionId || !VALID_DIRECTIONS.includes(improveDirection as NextActionKey))) {
      return NextResponse.json(
        { error: '迭代请求无效（需登录且指定有效的版本与方向）' },
        { status: 400 }
      )
    }
    // custom 方向必须携带用户的具体修改指令，否则模型不知道要改什么
    if (improveRaw && improveDirection === 'custom' && !improveInstruction) {
      return NextResponse.json(
        { error: '请先填写想怎么改（一句话修改要求）' },
        { status: 400 }
      )
    }
    if (auth && improveRaw && fromVersionId && improveDirection) {
      const { data: prevRow } = await auth.supabase
        .from('generation_history')
        .select(
          'id, user_id, project_id, topic, identity_label, style, category, blueprint, analysis, sample_text, work_tags'
        )
        .eq('id', fromVersionId)
        .maybeSingle()

      if (!prevRow || prevRow.user_id !== auth.userId || !prevRow.project_id) {
        return NextResponse.json({ error: '原版本不存在或不属于你的项目' }, { status: 404 })
      }

      const prevText = typeof prevRow.sample_text === 'string' ? prevRow.sample_text : ''
      const analysis = parseDiagnosis(prevRow.analysis)
      const bp = normalizeBlueprint(prevRow.blueprint)
      // 阶段 5：解析上一版 work_tags（可能为 null：老数据/分析失败）
      const prevWorkTags = normalizeWorkTags(prevRow.work_tags) ?? null
      const prevUsageTags: UsageTag[] = prevWorkTags?.usage_tags ?? []
      const actionMeta = NEXT_ACTION_META.find((m) => m.key === improveDirection)!
      const isCustom = improveDirection === 'custom'
      const diagLines = analysis
        ? [
            ...analysis.strengths.slice(0, 3).map((s) => `  [表现良好] ${s}`),
            ...analysis.improvements.slice(0, 3).map((s) => `  [需要改进] ${s}`),
            // 旧版诊断遗留字段：有则补上，无则忽略
            ...(analysis.problems ?? []).slice(0, 3).map((s) => `  [问题] ${s}`),
            ...(analysis.suggestions ?? []).slice(0, 3).map((s) => `  [建议] ${s}`),
          ].join('\n')
        : '  （暂无上一版诊断，请凭专业判断重写）'
      // custom 方向：以用户自己的一句话指令为最高优先级改法；
      // 其余方向优先用诊断里该方向的建议（旧数据），退回"需要改进"清单，最后才是泛化兜底
      const directionHow = isCustom
        ? improveInstruction
        : analysis?.nextActions?.[improveDirection as NextActionKey] ||
          (analysis?.improvements?.length ? analysis.improvements.join('；') : '') ||
          `按"${actionMeta.label}"方向整体提升`

      improveCtx = {
        direction: improveDirection as NextActionKey,
        instruction: isCustom ? improveInstruction : '',
        userFeedback: userFeedbackText,
        projectId: prevRow.project_id as string,
        topic: str(prevRow.topic, 500),
        identityLabel: str(prevRow.identity_label, 200) || '通用解说者',
        style: str(prevRow.style, 500),
        category: str(prevRow.category, 100) || '未指定',
        wordCount: Math.max(150, Math.min(prevText.trim().length || 300, 5000)),
        blueprint: bp,
        analysis,
        prevText: prevText.slice(0, 8000),
        prevUsageTags,
        promptText: `

【这是同一创作项目的定向迭代任务，不是新主题】
本次迭代方向：${actionMeta.emoji} ${actionMeta.label}——${actionMeta.blurb}
上一版的 AI 诊断：
${diagLines}
${isCustom ? '用户的自定义修改要求（最高优先级，必须落实）' : '本方向的具体改法'}：${directionHow}
【上一版全文】
${prevText.slice(0, 6000)}

迭代硬性要求：
1. 输出一篇完整的重写版（不是续写、不是补丁、不要罗列修改说明）；
2. ${isCustom
          ? '严格落实用户的自定义修改要求，同时保留上一版中与该要求不冲突的优势写法'
          : '保留诊断中"优势"对应的写法，逐条解决"问题"，把"建议"和本方向改法落到具体句子里'};
3. 主题、身份、品类与上一版保持一致，读者应能认出是同一个作品的进化版。`,
      }
    }

    // ── 预解析 topic：向量嵌入需要用到主题文本（improve 模式从上一版继承）──
    const topic = improveCtx?.topic ?? (typeof body.topic === 'string' ? body.topic.trim() : '')

    // 输出语言跟随用户主题：这是生成链路唯一的"用户亲笔输入"，
    // 用户用英文写主题就该得到英文正文，而不是被系统硬编码成中文
    const outputLanguage = resolveTargetLanguage([
      { text: topic, weight: 100, label: 'topic' },
      {
        text: typeof body.improve === 'object' && body.improve !== null
          ? String((body.improve as Record<string, unknown>).instruction ?? '')
          : '',
        weight: 60,
        label: 'improve.instruction',
      },
      { text: typeof body.customCategory === 'string' ? body.customCategory : '', weight: 20, label: 'customCategory' },
    ]).language

    // ── 登录用户：查询风格卡 + 创作者人格 + 向量检索参考内容 ──
    // 嵌入/检索失败不阻断生成主流程，仅降级为无参考内容
    let styleText = '' // 拼入 prompt 的风格描述文本
    let referenceContent = '' // 检索到的历史参考素材
    let foundationContent = '' // 用户指定的创作根基（权威事实来源，独立区块）
    let historyWorksText = '' // Creator Mode：该用户同主题历史作品真实摘录
    let historyWorkCount = 0 // 实际引用的历史作品数（身份声明中使用真实数字）
    let creatorText = '' // Creator Model 人格块（开关关闭时为空）
    let creatorAvoid: string[] = [] // 排斥元素硬禁忌（写进生成硬规则）
    // Material Library 2.0 Phase 3：素材召回结果（creatorEnabled 时才赋值，灵感模式下 materials 为空）
    let retrieved: { materials: MaterialRetrievalResult[] } = { materials: [] }
    // Material Library 2.0 Phase 3：前端传入的 selectedMaterialIds（非法形态已在内部清洗）
    let selectedMaterialIds: string[] = []
    // 素材创作注解（根基/标签/备注）：白名单清洗后用于分区注入 prompt
    let materialAnnotations: MaterialAnnotation[] = []
    let styleVec: number[] | null = null // 用户风格向量（第七阶段：本篇一致度计算用）
    let declarationTraits: DeclarationTrait[] = [] // 阶段 5：本次生效的声明维度（回传前端展示）
    // Creator Knowledge System Phase 3：本次实际注入的知识单元
    // 灵感模式/游客恒为空数组，游客分支不会读到个人知识
    let knowledgeBlock = ''
    let knowledgeUnits: CreatorKnowledgeUnit[] = []
    // Creator Knowledge System Phase 3：注入结果摘要。落库（versionRow.used_knowledge）
    // 与响应（usedKnowledgeUnits）共用这一份，两处各算一遍迟早会漂移。
    // 声明在最外层是因为最终响应在 auth 块之外：未登录/灵感模式下保持空数组。
    let usedKnowledge: InjectedUnitSummary[] = []

    // Creator Mode 裁决（improve 迭代时由前端沿用上一版模式）；旧 useCreatorModel 自动兼容
    const mode: CreationMode = resolveMode(body.mode, !!auth, body.useCreatorModel)
    // 任务隔离裁决：improve 迭代或显式传 projectId = continuation（允许继承项目角色/剧情/世界观）；
    // 其余一律 new（禁止继承历史具体内容，只借鉴抽象风格，解决跨主题污染）
    const taskMode: TaskMode =
      !!improveCtx || (typeof body.projectId === 'string' && body.projectId.trim().length > 0)
        ? 'continuation'
        : 'new'
    const plan = planPersonalization(mode, taskMode)
    const creatorEnabled = mode === 'creator'

    // 个人化证据（返回前端展示"本次参考了什么"）
    const evidence: PersonalizationEvidence = {
      mode,
      enabled: creatorEnabled,
      layers: [],
      materialCount: 0,
      dimensionSamples: 0,
    }

    // 灵感模式整块跳过：不查风格卡、不调 embedding、不做素材检索（真剥离且省成本）
    if (auth && creatorEnabled) {
      // 1) 查询风格卡（style_vector + 五维画像 + Creator Model + 9.6 DNA 报告）
      // 走统一 repo：未执行 9.6 迁移时自动降级旧列，生成链路不中断
      const profile = await fetchCreatorStyleProfile(auth.supabase, auth.userId, true)

      const styleProfile = profile as
        | (StyleProfile & {
            style_dimensions?: unknown
            editing_profile?: unknown
            creator_personality?: unknown
            topic_preferences?: unknown
            favorite_elements?: unknown
            avoid_elements?: unknown
            ai_creator_summary?: unknown
            creator_report?: unknown
            creator_declaration?: unknown
            interest_profile?: unknown
          })
        | null

      if (styleProfile) {
        // 个人数据注入统一走装配器（Creator Context）：与方案 / 蓝图同口径。
        // 各块的取舍、顺序、预算、硬禁忌合并规则都收敛在装配器里，
        // 这里只负责把结果接进本次生成的 styleText / creatorText / 硬禁忌。
        const blocks = buildCreatorContextBlocks(styleProfile, { stage: 'article' })
        styleText = `\n\n${blocks.styleText}`
        creatorText = blocks.creatorText
        creatorAvoid = [...blocks.avoid]
        evidence.layers.push(...blocks.layers)
        declarationTraits = blocks.declarationTraits
        // 第七阶段：本次采用的创作者特征（DNA 真实统计，供作品页"本次作品采用"展示）
        evidence.traits = blocks.traits
        evidence.dimensionSamples = parseStyleDimensions(styleProfile.style_dimensions).samples

        // Creator Understanding Engine：长期关注领域注入。
        // 修复背景：interest_profile 由 builder 持续计算，但生成链路此前从未 select 该列，
        // 导致「AI 不知道用户关注什么」。此处只拼入 creatorText 作软参考，
        // 不进入 creatorAvoid —— 行为推断出的负向倾向不构成硬约束。
        if (blocks.interestText) {
          creatorText = (creatorText ? creatorText + '\n' : '') + blocks.interestText
        }
      }

      // 1.5) Creator Knowledge System Phase 3：知识单元注入
      // 只读「已确认 + 置信度达标」的单元 —— AI 侧写的候选到不了这里，
      // 候选→确认必须由用户在 /knowledge 手动完成，这是整条授权链的落点。
      // 灵感模式/游客不进本分支，因此天然读不到任何知识单元（与个人化数据同口径）。
      const knowledge = await buildKnowledgeInjection(
        auth.supabase,
        auth.userId,
        topic
      )
      knowledgeBlock = knowledge.block
      knowledgeUnits = knowledge.units
      if (knowledge.units.length > 0) {
        evidence.layers.push('创作者知识单元')
      }

      // 2) 生成主题文本的嵌入向量（用于向量检索）
      const topicEmbedding = await generateEmbedding(topic)

      // 3) 向量检索
      if (topicEmbedding) {
        styleVec = parseVector(styleProfile?.style_vector)

        // ── 素材库召回（Material Library 2.0 Phase 3 检索服务）──
        // 纯主题向量（绝不混 styleVec，修复风格偶合关键词污染）+ 0.55 硬阈值 +
        // ±0.02 相似度带内标签软排序；usage/material_type 不再是硬过滤参数。
        // 复用上方已生成的 topicEmbedding（零新增 embedding）；理由固定模板（0 LLM）。
        const bpEarly = improveCtx
          ? improveCtx.blueprint
          : normalizeBlueprint(body.blueprint)
        // blueprint 跨模块传递、结构宽松：这里只取两个可选字段，用最小结构断言代替 any
        type BlueprintShape = { content_type?: string; usage_tag?: string }
        const currentContentType = improveCtx
          ? ((improveCtx.blueprint as BlueprintShape | null)?.content_type ?? '')
          : ((bpEarly as BlueprintShape | null)?.content_type ?? '')
        const currentUsageTag = improveCtx
          ? (improveCtx.blueprint as BlueprintShape | null)?.usage_tag
          : (bpEarly as BlueprintShape | null)?.usage_tag
        // improve 模式下把 prevUsageTags 包成 WorkTags 形态喂给 inferUsageFilter
        const prevWorkTagsForInfer: WorkTags | null = improveCtx?.prevUsageTags?.length
          ? ({
              work_type: '', theme: '', expression_style: '', emotion: '',
              audience: '', narrative_structure: '', core_viewpoint: '',
              content_tags: [], emotion_tags: [], expression_tags: [], audience_tags: [],
              thought_tags: [], usage_tags: improveCtx.prevUsageTags,
            } as unknown as WorkTags)
          : null
        const usageFilter = inferUsageFilter(currentContentType, currentUsageTag, prevWorkTagsForInfer)

        // 素材创作注解（根基/标签/备注）：白名单清洗；存在注解时以注解 id 作为选中集，
        // 否则回落到旧 selectedMaterialIds 字符串数组（旧客户端零感知）。
        // improve 链路前端当前不传两者，保留自动召回。
        materialAnnotations = sanitizeMaterialAnnotations(body.materialAnnotations)
        selectedMaterialIds =
          materialAnnotations.length > 0
            ? materialAnnotations.map((a) => a.materialId)
            : Array.isArray(body.selectedMaterialIds)
              ? (body.selectedMaterialIds.filter((x) => typeof x === 'string') as string[]).slice(0, 10)
              : []

        retrieved = await retrieveMaterials(
          auth.supabase,
          {
            userId: auth.userId,
            currentTopic: topic,
            currentIntent: usageFilter ?? currentContentType,
            selectedMaterialIds,
          },
          { topicEmbedding, reasonMode: 'template' }
        )

        if (retrieved.materials.length > 0) {
          evidence.materialCount = retrieved.materials.length
          const selectedIdSet = new Set(selectedMaterialIds)
          const annotationMap = new Map(materialAnnotations.map((a) => [a.materialId, a]))

          // 拼装单条注解的"使用要求"行（预设标签 + 用户备注；都为空则返回空串）
          const formatUsage = (a: MaterialAnnotation | undefined): string => {
            if (!a || (a.tags.length === 0 && !a.note)) return ''
            const parts: string[] = []
            if (a.tags.length > 0) parts.push(`标签：${a.tags.join('、')}`)
            if (a.note) parts.push(`备注：${a.note}`)
            return `｜使用要求：${parts.join('；')}`
          }

          // 素材类型使用规则（9 种类型各自的使用约束）：
          //   此前只展示在 UI 上（/add、AI 理解抽屉、素材选择器），AI 生成时收不到，
          //   导致「金句优先保留原表达」「经历不得擅自变成客观事实」这类约束实际不生效。
          //   这里随素材原文一起注入 prompt；无类型（legacy 素材）时返回空串，不注入。
          const formatTypeRule = (t: MaterialType | null | undefined): string => {
            if (!t) return ''
            const rule = MATERIAL_TYPE_RULES[t]?.usageRule
            return `素材类型：${t}（使用规则：${rule ?? '按上下文灵活使用'}）\n`
          }

          // ── 创作根基：role=foundation 的用户指定素材，独立权威区块 ──
          // 放宽截断到 1000 字（根基常含产品完整定位）；被 RLS 静默丢弃时
          // （annotationMap 有 id 但 retrieved 无此条）自然不会出现，零副作用。
          const FOUNDATION_SLICE = 1000
          const foundationItem = retrieved.materials.find(
            (m) => annotationMap.get(m.materialId)?.role === 'foundation'
          )
          if (foundationItem && foundationItem.content.trim().length > 0) {
            evidence.layers.push('素材创作根基')
            foundationContent =
              `\n\n【创作根基 · 本篇最高优先级的事实来源】\n` +
              `以下素材是用户明确指定的本篇创作根基。其中的名称、定位与事实必须严格遵循，` +
              `严禁虚构与其冲突的信息；它决定本篇"表达什么"，优先级高于其他参考素材与通用创作经验：\n` +
              `1. ${formatTypeRule(foundationItem.materialType)}素材原文：${foundationItem.content.slice(0, FOUNDATION_SLICE)}` +
              `${formatUsage(annotationMap.get(foundationItem.materialId))}`
          }

          // ── 辅助参考素材：根基之外的素材沿用原区块（selected 置顶/相似度理由）──
          // 注入总条数 ≤ MAX_INJECT_TOTAL（selected 已在结果中置顶、优先占额）；
          // 空 content（图片素材）跳过不注入；每条 content 仍截前 500 字。
          const referenceItems = retrieved.materials
            .filter((m) => m.materialId !== foundationItem?.materialId)
            .filter((m) => m.content.trim().length > 0)
            .slice(0, MAX_INJECT_TOTAL)
          if (referenceItems.length > 0) {
            evidence.layers.push('素材库相关参考')
            referenceContent = referenceItems
              .map((m) => {
                const head = selectedIdSet.has(m.materialId)
                  ? '（用户指定）'
                  : `（相似度 ${Math.round(m.relevanceScore * 100)}%）`
                return `${head}${formatTypeRule(m.materialType)}${m.content.slice(0, 500)}｜理由：${m.relevanceReason}${formatUsage(
                  annotationMap.get(m.materialId)
                )}`
              })
              .join('\n---\n')
          }
        }

        // 4) Creator Mode 历史作品检索：只用纯主题向量，不再混入 styleVec。
        //    历史作品正文带有强主题特征（如"僵尸/道士"），混入 30% 风格向量会让
        //    "风格相近但主题无关"的旧作也获得高分，造成跨主题污染。
        //    相似度阈值 0.55：低于此值视为主题不相关，宁可不注入也不能污染。
        const HISTORY_SIMILARITY_THRESHOLD = 0.55
        const { data: works, error: worksErr } = await auth.supabase.rpc('match_user_works', {
          query_embedding: topicEmbedding,
          match_count: 8,
          p_user_id: auth.userId,
        })
        if (worksErr) {
          console.error('历史作品检索失败（不影响生成）:', worksErr)
        } else if (Array.isArray(works) && works.length > 0) {
          // 同项目多版本/同主题作品去重：按 topic 归一后只保留相似度最高的一篇
          const seenTopics = new Set<string>()
          const picked: { topic?: string; sample_text?: string; similarity?: number }[] = []
          for (const w of works as { topic?: string; sample_text?: string; similarity?: number }[]) {
            const sim = typeof w.similarity === 'number' ? w.similarity : 0
            // 相似度阈值过滤：低于阈值的旧作主题不相关，禁止注入防止污染
            if (sim < HISTORY_SIMILARITY_THRESHOLD) continue
            const key = (w.topic ?? '').trim().slice(0, 30)
            if (key && seenTopics.has(key)) continue
            if (key) seenTopics.add(key)
            picked.push(w)
            if (picked.length >= 3) break
          }
          if (picked.length > 0) {
            historyWorkCount = picked.length
            evidence.layers.push('历史作品参考')
            historyWorksText = picked
              .map(
                (w, i) =>
                  `旧作${i + 1}《${(w.topic ?? '未命名').slice(0, 60)}》（主题相似度 ${((w.similarity ?? 0) * 100).toFixed(0)}%）\n${(w.sample_text ?? '').slice(0, 400)}`
              )
              .join('\n---\n')
          }
        }
      }
    }

    // 解析并校验输入（improve 模式全部从上一版继承，忽略表单字段）
    // style 在方案解析后再确定（可能由 language_style 合成），此处暂存表单输入
    const formStyle = improveCtx?.style ?? (typeof body.style === 'string' ? body.style.trim() : '')
    const wordCountNum = Number(body.wordCount)
    const wordCount = improveCtx
      ? improveCtx.wordCount
      : Number.isFinite(wordCountNum) && wordCountNum > 0
        ? Math.min(Math.floor(wordCountNum), 5000)
        : 0

    if (!topic) {
      return NextResponse.json({ error: '请填写解说主题' }, { status: 400 })
    }
    if (!wordCount) {
      return NextResponse.json({ error: '请填写有效的字数' }, { status: 400 })
    }

    // 解析身份：优先用自定义，其次匹配模板（improve 模式沿用上一版身份，无模板描述）
    // 阶段 C：若携带创作方案（蓝图超集），身份/品类/文风/字数由方案派生，不再依赖模板
    const blueprint: CreativeBlueprint | null = improveCtx
      ? improveCtx.blueprint
      : normalizeBlueprint(body.blueprint)
    const bp = blueprint as (CreativeBlueprint & {
      content_type?: string
      language_style?: { pace?: string; mood?: string; expression?: string }
      market_constraints?: {
        avoid_points: string[]
        target_gaps: string[]
        strategy_action: 'reference' | 'upgrade' | 'avoid'
        strategy_reason: string
      }
    }) | null

    // ── 阶段 2：identity 强制 AI 方案驱动，不再依赖用户模板/自定义 ──
    // 方案路径：persona_hint 来自 CreativePlan（AI 自动推断）
    // 非方案路径（降级）：固定为"通用创作视角"，不再用 identityTemplates
    const identity = bp
      ? `创作视角：${bp.persona_hint || '通用创作者视角'}（AI 方案驱动，非固定身份标签）`
      : '创作视角：通用创作者视角（由 AI 根据主题自然确定）'
    const identityLabel = bp
      ? bp.persona_hint || '通用创作者视角'
      : '通用创作者视角'

    // ── 内容类型：强制依赖 blueprint.content_type ──
    // 阶段 2：不再从 body.category / improveCtx.category 取值
    const category = bp?.content_type || '未指定'
    const categoryLine = `内容品类：${category}`

    // ── 文风：强制依赖 blueprint.language_style 三维合成 ──
    // 阶段 2：不再从 body.style 取值（用户手动文风已删）
    const writingStyle = bp?.language_style
      ? [bp.language_style.pace, bp.language_style.mood, bp.language_style.expression]
          .filter(Boolean)
          .join(' · ')
      : ''

    // ── 用户历史风格记忆（前端已聚合统计，此处仅做长度截断） ──
    const mem =
      typeof body.memory === 'object' && body.memory !== null
        ? (body.memory as Record<string, unknown>)
        : {}
    const memIdentity = str(mem.identities, 300) || '暂无'
    const memStyles = str(mem.styles, 300) || '暂无'
    const memCategories = str(mem.categories, 300) || '暂无'
    // 偏爱范文摘录：前端 buildMemorySummaryForTopic(topic) 已按主题相关性过滤，
    // 命中 0 篇时返回空串；此处不再硬兜底"暂无收藏范文"，避免无关范文污染当前主题。
    // 兼容旧前端：仍读取 mem.favored 字段（旧 buildMemorySummary 返回），但只有非空才注入。
    const memFavored = str(mem.favoredExcerpts, 1500) || str(mem.favored, 1500) || ''
    // 证据：本地历史风格记忆实际有内容时计入个性化层（灵感模式不注入、不计层）
    if (
      plan.useLocalMemory &&
      (memIdentity !== '暂无' || memStyles !== '暂无' || memFavored !== '')
    ) {
      evidence.layers.push('历史创作记忆')
    }
    // improve 模式下迭代任务优先于人格偏好（避免人格块与迭代指令冲突）
    const effectiveCreatorText = creatorText
      ? `${creatorText}${improveCtx ? '\n注意：本次为定向迭代，若人格偏好与迭代任务书冲突，以迭代任务书为准。' : ''}`
      : ''

    // 灵感模式：历史记忆段整块不进入 prompt（零污染）；我的模式：沿用原微调参考段
    // 偏爱范文行只在命中时出现（memFavored 非空），避免无关范文污染当前主题
    const memBlockFirst = plan.useLocalMemory
      ? `【用户历史风格记忆（仅作为微调参考，本次表单指令优先级更高）】
历史高频身份：${memIdentity}
历史常用文风：${memStyles}
常用品类：${memCategories}${memFavored ? `\n收藏范文语言特征：${memFavored}` : ''}`
      : ''
    const memBlockSecond = plan.useLocalMemory
      ? `【用户历史风格记忆（仅作为微调参考，当前系统提示词与本次要求优先级更高）】
历史高频身份：${memIdentity}
历史常用文风：${memStyles}${memFavored ? `\n收藏范文语言特征：${memFavored}` : ''}`
      : ''

    // Creator Mode 第五阶段：长期专属 AI 身份声明（仅我的模式；真实引用数，不编造）
    // 任务隔离边界由 taskMode 控制：new=禁止继承历史具体内容；continuation=允许继承项目设定
    const creatorIdentity = buildCreatorIdentity(mode, taskMode, historyWorkCount)
    // 该用户的同主题历史作品原文摘录（AI 模仿真实行文，而不只是统计标签）
    // 注意：只在主题相似度 ≥ 0.55 时注入；低于阈值的旧作已被过滤掉，不会污染本次创作
    const historyWorksBlock = historyWorksText
      ? `\n\n【该创作者与本次主题高度相近的真实历史作品（仅作为风格/行文参考，不要照抄具体内容；如本次为新独立任务，禁止继承其中的角色/剧情/世界观）】\n${historyWorksText}`
      : ''

    // ── 阶段四：登场角色（快照清洗 + 四层约束块；空数组零污染）──
    const characters = sanitizeCharacterInput(body.characters)
    const characterBlock = formatCharactersForPrompt(characters)
    if (characters.length > 0) {
      evidence.layers.push('登场角色设定')
    }

    // ── 创作蓝图 ──
    // 已在上方解析（bp）；此处仅拼装 prompt 文本
    const bpPromptText = blueprint ? `\n\n${formatBlueprintForPrompt(blueprint)}` : ''
    // 阶段 5：定向迭代任务书（诊断 + 方向 + 上一版全文）
    const improvePromptText = improveCtx?.promptText ?? ''

    // 四层上下文优先级声明（仅我的模式注入；灵感模式无个人数据无冲突源，保持简洁）
    // 解决"历史作品污染当前主题"问题：低优先级信息不得覆盖高优先级信息
    const priorityBlock = creatorEnabled
      ? `\n【上下文优先级（冲突时高优先级覆盖低优先级，不可颠倒）】
P0 本次主题与表单要求（解说主题/身份/字数/创作方案）——最高，任何历史数据不得改变本次方向
P1 创作者人格与抽象风格特征（语言节奏/叙事方式/创作者人格）——只决定"怎么表达"，不决定"表达什么"
P2 与本次主题高度相关的历史作品（仅相似度≥0.55 时出现；新独立任务下不得继承其中的具体角色/剧情/世界观）
P3 兴趣偏好与母题倾向——仅供参考，不得覆盖 P0
${taskMode === 'new' ? '本次任务模式：新独立创作（New Creative Task）。历史作品只可作为抽象风格参考；禁止把历史中出现的具体角色名、剧情桥段、世界观设定带入本次正文。' : '本次任务模式：继续创作（Continuation Mode）。允许继承该项目下既有角色、剧情、世界观设定。'}`
      : ''

    // ── 第 1 次 LLM 调用：生成结构化系统提示词 ──
    const promptBuilderMessages = [
      {
        role: 'system',
        content:
          '你是提示词工程师。你的任务是根据用户输入，生成一份结构化的系统提示词。严格按以下 5 个板块输出，每个板块用【】标注标题，板块内不要有多余寒暄：\n【角色定位】\n【语言风格】\n【任务要求】\n【字数硬性限制】\n【禁止事项】',
      },
      {
        role: 'user',
        content: `${creatorIdentity ? `${creatorIdentity.forPromptBuilder}\n\n─── 以下是该创作者的资料与本次创作要求 ───\n\n` : ''}请根据以下信息生成系统提示词：

解说主题：${topic}
解说身份：${identityLabel}（${identity}）
文风风格：${writingStyle || '由身份自然决定'}
${categoryLine}
目标字数：${wordCount} 字
${memBlockFirst ? `\n${memBlockFirst}` : ''}${styleText}${effectiveCreatorText}${characterBlock.text}${foundationContent}${referenceContent ? `\n\n【用户素材库中与主题相关的参考内容】\n（每条素材标注的"使用规则"是该类型素材的使用约束，生成时必须遵守）\n${referenceContent}` : ''}${historyWorksBlock}${priorityBlock}

要求：
1. 严格按 5 个板块结构输出
2. 【任务要求】需贴合上述"内容品类"的典型结构、节奏与受众预期；如历史记忆与本次表单冲突，以本次表单为准${bp ? '\n3. 【创作要素优先级】（冲突时高优先级覆盖低优先级，不可颠倒）：\n   ① 用户已确认的创作方案（内容类型/方向/视角/叙事结构/字数）——最高；\n   ② 该创作者的人格与历史风格——只决定"怎么表达"，不得改变第①条的方向；\n   ③ ' + (foundationContent ? '创作根基（用户指定的权威事实来源，名称/定位/事实必须严格遵循，严禁虚构冲突信息）优先级高于其余一切素材；' : '') + '素材库相关参考——只供事实与细节；\n   ④ 平台通用创作经验——兜底。\n   角色定位中的"身份"必须是"创作视角"（如何切入），不得写成"XX人/XX博主"等身份标签。' : ''}
${bp ? '4' : '3'}. 【字数硬性限制】板块必须明确写出"总字数严格控制在 ${wordCount} 字（±10%，即 ${Math.floor(wordCount * 0.9)}-${Math.ceil(wordCount * 1.1)} 字）"
${bp ? '5' : '4'}. 【禁止事项】板块至少列 3 条${creatorEnabled ? `\n${bp ? '6' : '5'}. 【禁止事项】必须包含任务隔离硬规则：${taskMode === 'new' ? '不得把历史作品中的具体角色名、剧情桥段、世界观设定带入本次创作；只允许借鉴抽象的语言节奏、叙事方式。' : '继续创作模式下，只允许继承本项目既有的角色/剧情/世界观，不得引入其他历史作品的具体内容。'}` : ''}
${bp ? '6' : '5'}. 语言精炼、指令清晰，可直接复制给大模型使用${bpPromptText}${improvePromptText ? `\n\n请为这次"${NEXT_ACTION_META.find((m) => m.key === improveCtx?.direction)?.label}"定向迭代重建系统提示词，在【任务要求】中体现该迭代方向与下方诊断结论。${improvePromptText}` : ''}`,
      },
    ]

    const promptRes = await callDeepSeekChat({
      messages: promptBuilderMessages as ChatMessage[],
      temperature: 0.3,
      max_tokens: 1500,
      // 生成 1500 tokens 正常约 50s，默认 30s 会在高峰期把正常请求掐成超时，
      // 用户侧表现为"系统提示词生成失败"。上限对齐 maxDuration=60（留 5s 响应余量）。
      timeoutMs: 55_000,
      language: outputLanguage,
    })

    if (!promptRes.ok) {
      console.error('系统提示词生成失败:', promptRes.error)
      // 一个 token 都没产出：预扣必须全额退，不能让用户为失败买单
      if (billing) {
        await refundAiCost({
          supabase: billing.supabase,
          userId: billing.userId,
          refId: billing.refId,
          amount: billing.reserved,
          reason: `系统提示词生成失败（${promptRes.error}）`,
        })
        billing = null
      }
      // 文案按原因区分（余额耗尽 / 超时 / 网络故障），502/503 而非 500：
      // 这是上游不可用，不是本服务代码错误，且不触发任何登录态变更
      return NextResponse.json(
        { error: llmUserMessage(promptRes.error), detail: promptRes.error },
        { status: isLlmNetworkError(promptRes.error) ? 503 : 502 }
      )
    }

    const systemPrompt = promptRes.content

    if (systemPrompt.trim().length === 0) {
      return NextResponse.json(
        { error: '系统提示词生成失败，请稍后重试', detail: 'empty_content' },
        { status: 500 }
      )
    }

    // ── 第 2 次 LLM 调用：用系统提示词 + 风格记忆生成解说范文 ──
    const sampleMessages = [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: `${creatorIdentity ? `${creatorIdentity.forWriter}\n\n` : '你是专属短视频文案创作助手。请根据系统提示词中的角色设定创作一篇解说文案。\n'}【本次即时要求】
创作主题：${topic}
创作者身份：${identityLabel}
文风要求：${writingStyle || '由身份自然决定'}
${categoryLine}
目标字数：${wordCount} 字，允许误差±10%（即 ${Math.floor(wordCount * 0.9)}-${Math.ceil(wordCount * 1.1)} 字）
${memBlockSecond ? `\n${memBlockSecond}` : ''}${effectiveCreatorText}${characterBlock.text}${historyWorksBlock}${knowledgeBlock ? `\n\n${knowledgeBlock}` : ''}

创作硬性规则：
1、文案框架、叙事逻辑贴合当前内容品类；
${plan.useLocalMemory
  ? '2、优先遵守系统提示词设定的身份与文风，同时吸收用户过往收藏范文的语感、句式、金句习惯，做到越使用越贴合用户个人调性；'
  : '2、优先遵守系统提示词设定的身份与文风，以平台通用的专业叙事经验完成创作，不要臆测用户的个人偏好或历史风格；'}
3、杜绝模板化流水线文案，不要多余解释、前言分析，直接输出最终成品文案正文，不要输出标题和字数统计；${characters.length ? `
4、登场角色硬规则：必须写出以下角色且名字、背景、性格与设定完全一致，言行符合人设，不得改名或改编设定：${characters.map((c) => c.name).join('、')}。` : ''}${blueprint ? `
5、必须严格遵循已确认创作蓝图：按蓝图的叙事结构推进，开头使用蓝图的 Hook，围绕核心冲突展开，情绪按蓝图的情绪曲线递进，结尾完成蓝图的价值升华；叙述人格贴合蓝图建议。` : ''}${improveCtx ? `
6、本次为定向迭代：必须完成下方迭代任务书，保留优势、逐条解决问题，输出完整重写版而不是修改说明。` : ''}${creatorEnabled ? `
${characters.length || blueprint || improveCtx ? '7' : '4'}、任务隔离硬规则（${taskMode === 'new' ? '新独立创作任务' : '继续创作任务'}）：${taskMode === 'new' ? '禁止把历史作品中的具体角色名、剧情桥段、世界观设定带入本次正文；只允许借鉴历史中抽象的语言节奏、叙事方式、创作者人格。即便上方给出了"历史作品参考"，也只可参考其行文风格，不得照抄其中的角色、情节、专有名词。' : '允许继承本项目下既有的角色、剧情、世界观设定；但不得引入本项目以外的其他历史作品的具体内容。'}` : ''}
${creatorAvoid.length ? `个性化硬禁忌（该创作者明确排斥，出现即视为失败）：${creatorAvoid.join('、')}\n` : ''}${blueprint ? formatBlueprintForPrompt(blueprint) : ''}${improvePromptText}`,
      },
    ]

    // 定向迭代模式要求 LLM 额外输出一句"AI 修改说明"（improveNote），
    // 与正文分开返回，避免说明文字污染成稿 → 该模式强制 JSON 输出。
    if (improveCtx) {
      sampleMessages.push({
        role: 'user',
        content: `输出格式硬性要求：只输出一个 JSON 对象（不要 markdown 代码块、不要任何解释），结构为：
{"article":"完整重写版正文（不要标题、不要字数统计）","improveNote":"一句话说明本版相对上一版最关键的修改，30-60 字，面向用户，具体可感知，例如'把开头改成悬念反问，并在中段补了一个真实案例'"}`,
      })
    }

    // max_tokens 给足余量：中文约 1 字 ≈ 1.5 token；improve 模式另留 ~300 token 给修改说明
    const sampleRes = await callDeepSeekChat({
      messages: sampleMessages as ChatMessage[],
      temperature: 0.8,
      max_tokens: Math.ceil(wordCount * 1.1 * 2) + (improveCtx ? 400 : 0),
      jsonMode: !!improveCtx,
      // 同上：大字数范文正常生成超过 30s，默认超时会把范文掐成"范文生成失败"
      timeoutMs: 55_000,
      // 正文是最重要的输出：语言必须跟随用户主题，网关层会做校验并在必要时自纠偏一次
      language: outputLanguage,
    })

    if (!sampleRes.ok) {
      console.error('范文生成失败:', sampleRes.error)
      // 同上：用户没拿到任何正文，预扣全额退
      if (billing) {
        await refundAiCost({
          supabase: billing.supabase,
          userId: billing.userId,
          refId: billing.refId,
          amount: billing.reserved,
          reason: `范文生成失败（${sampleRes.error}）`,
        })
        billing = null
      }
      return NextResponse.json(
        { error: llmUserMessage(sampleRes.error), detail: sampleRes.error },
        { status: isLlmNetworkError(sampleRes.error) ? 503 : 502 }
      )
    }

    const rawSample: string = sampleRes.content

    // improve 模式：解析 {article, improveNote}；JSON 异常时降级把全文当正文，
    // 绝不让"修改说明"这个增强项拖垮整版生成。
    let sampleText = rawSample
    let improveNote: string | null = null
    if (improveCtx) {
      try {
        const cleaned = rawSample.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        const parsed = JSON.parse(cleaned) as { article?: unknown; improveNote?: unknown }
        if (typeof parsed.article === 'string' && parsed.article.trim()) {
          sampleText = parsed.article
          improveNote =
            typeof parsed.improveNote === 'string' && parsed.improveNote.trim()
              ? parsed.improveNote.trim().slice(0, 200)
              : null
        }
      } catch {
        // 降级：LLM 未按 JSON 返回，沿用原文（improveNote 留空，版本仍正常生成）
        console.warn('迭代版 JSON 解析失败，降级为纯文本正文')
      }
    }

    if (typeof sampleText !== 'string' || sampleText.trim().length === 0) {
      return NextResponse.json(
        { error: '范文生成失败，请稍后重试' },
        { status: 500 }
      )
    }

    // ── 生成成功：登录用户写入生成历史（生成失败时不会走到这里，不插记录）──
    // 创作进化系统阶段 3 的分岔：
    //   有蓝图 + 登录 = 创作进化模式：
    //     · 传 projectId → 在该项目下 INSERT 新版本（V2/V3…），旧版本只读保留，绝不覆盖
    //     · 未传 projectId → 新建 creative_projects，INSERT V1
    //   无蓝图（游客 / 蓝图降级）= 旧模式：按前端 id upsert 单行
    // 任何项目/版本写库失败都降级为旧模式 upsert，不阻断生成主流程。
    const fallbackGenId = str(body.generationId, 100) || crypto.randomUUID()
    let resultGenId = fallbackGenId
    let resultProjectId: string | null = null
    let resultVersionNumber: number | null = null
    // M1 兴趣事件：仅在版本行确认写入成功后登记，三个分支统一在块尾补发一次
    let trackedEvent: { genId: string; projectId: string | null; versionNumber: number | null } | null =
      null

    if (auth) {
      // 生成 sample_text 的嵌入向量（存入 generation_history.embedding，供风格向量计算用）
      const sampleEmbedding = await generateEmbedding(sampleText)

      // 第七阶段：本篇与用户历史风格向量的真实一致度（余弦相似度）。
      // 两者都是现成数据（落库本就要算 embedding / 检索本就要读 style_vector），零额外成本；
      // 任一缺失（新用户无向量/embedding 服务失败）时不展示，绝不编造百分比。
      const styleMatch =
        sampleEmbedding && styleVec && styleVec.length > 0
          ? cosineSimilarity(sampleEmbedding, styleVec)
          : null
      if (styleMatch !== null) {
        evidence.styleMatch = styleMatch
      }

      // 第七阶段：个性化证据快照随版本落库（跨设备可追溯；灵感模式为极小对象）
      const evidenceSnapshot = {
        ...evidence,
        layers: Array.from(new Set(evidence.layers)),
      }

      usedKnowledge = summarizeInjectedUnits(knowledgeUnits)

      const versionRow = {
        user_id: auth.userId,
        topic: topic.slice(0, 500),
        // 阶段 2：identity_label/style/category 不再作为生成约束，落库留空
        // 完整标签由 blueprint（AI 方案）和 work_tags（作品分析）承担
        identity_label: '',
        style: '',
        category: '',
        system_prompt: systemPrompt,
        sample_text: sampleText,
        feedback_status: null,
        embedding: sampleEmbedding,
        blueprint,
        // 阶段 5：定向迭代版记录方向（V1/普通生成为 null）
        improve_direction: improveCtx?.direction ?? null,
        // 第四阶段：AI 对本版"改了什么、为什么"的一句话说明（V1/普通生成为 null）
        improve_note: improveCtx ? improveNote : null,
        // 阶段 4 Work Agent：该版本基于哪条用户反馈生成（V1/非反馈驱动迭代为 null）
        // userFeedback 是用户说的原话，与 improve_note（AI 说改了什么）互补
        user_feedback: improveCtx?.userFeedback || null,
        // 阶段四：登场角色快照随版本落库（换设备后可追溯；无角色为 null）
        characters: characters.length ? characters : null,
        // Creator Mode：本篇创作模式（灵感/我的），用于迭代沿用与模式效果分析
        generation_mode: mode,
        // 第七阶段：个性化证据快照（本次采用了什么特征/数据层，跨设备可追溯）
        personalization: evidenceSnapshot,
        // AI 灵感分析系统：原始灵感+分析结果+召回素材 ID 一次性落库
        // 一次 generation_id 串起 灵感→分析→plan→作品→反馈 全链路
        // 非灵感入口（直接 plan / improve）为 null，老链路不受影响
        inspiration_context: normalizeInspirationAnalysis(body.inspirationContext) ?? null,
        // Creator Knowledge System Phase 3：本次真正依赖的知识单元快照。
        // 与响应里的 usedKnowledgeUnits 取同一次 summarizeInjectedUnits 结果，
        // 避免「页面当时说参考了 3 条、历史记录里只剩 2 条」的口径分裂。
        // 空数组一律存 null：不用 [] 表达「没用到」，是为了把「确实没参考知识」
        // 与「这条版本行早于本列上线、自然没有值」区分开。
        used_knowledge: usedKnowledge.length ? usedKnowledge : null,
      }

      // improve 模式必然归属某项目（projectId 从版本行继承，不信任前端）；
      // 普通创作进化模式需有蓝图。二者都走项目版本分支。
      if (blueprint || improveCtx) {
        const projectIdParam = improveCtx?.projectId ?? str(body.projectId, 100)

        if (projectIdParam) {
          // ── 已有项目：校验归属 → 取下一版本号 → INSERT（不覆盖）→ 更新项目 current_version ──
          const { data: project } = await auth.supabase
            .from('creative_projects')
            .select('id, current_version')
            .eq('id', projectIdParam)
            .maybeSingle()

          if (project) {
            const nextVersion = Number(project.current_version ?? 0) + 1
            const versionId = `${projectIdParam}::v${nextVersion}`
            const { error: insertErr } = await auth.supabase
              .from('generation_history')
              .insert({
                ...versionRow,
                id: versionId,
                project_id: projectIdParam,
                version_number: nextVersion,
              })

            if (!insertErr) {
              await auth.supabase
                .from('creative_projects')
                .update({
                  current_version: nextVersion,
                  // 迭代出新版本意味着项目重新进入 active（即使用户此前定稿过）
                  status: 'active',
                  updated_at: new Date().toISOString(),
                })
                .eq('id', projectIdParam)
              resultGenId = versionId
              resultProjectId = projectIdParam
              resultVersionNumber = nextVersion
              trackedEvent = { genId: versionId, projectId: projectIdParam, versionNumber: nextVersion }
              // 阶段 5：把"选择的优化方向"作为风格信号沉淀（失败静默，不阻断）
              if (improveCtx) {
                recordDirectionSignal(auth.supabase, auth.userId, improveCtx.direction)
              }
            } else {
              console.error('新版本写入失败，降级 upsert:', insertErr)
            }
          } else {
            console.warn('projectId 不存在或不属于当前用户，降级为旧模式 upsert')
          }
        } else {
          // ── 新项目：先建 creative_projects，再 INSERT V1 ──
          const { data: newProject, error: projectErr } = await auth.supabase
            .from('creative_projects')
            .insert({
              user_id: auth.userId,
              title: topic.slice(0, 200),
              topic: topic.slice(0, 500),
              status: 'active',
              current_version: 1,
            })
            .select('id')
            .single()

          if (newProject && !projectErr) {
            const pid = newProject.id as string
            const versionId = `${pid}::v1`
            const { error: insertErr } = await auth.supabase
              .from('generation_history')
              .insert({
                ...versionRow,
                id: versionId,
                project_id: pid,
                version_number: 1,
              })

            if (!insertErr) {
              resultGenId = versionId
              resultProjectId = pid
              resultVersionNumber = 1
              trackedEvent = { genId: versionId, projectId: pid, versionNumber: 1 }
            } else {
              console.error('V1 写入失败，降级 upsert:', insertErr)
            }
          } else {
            console.error('创作项目创建失败，降级 upsert:', projectErr)
          }
        }
      }

      // 降级路径（无蓝图 / 项目写入失败）：旧模式 upsert 单行
      if (!resultProjectId) {
        const { error: histErr } = await auth.supabase
          .from('generation_history')
          .upsert(
            { ...versionRow, id: fallbackGenId },
            { onConflict: 'id' }
          )
        if (histErr) {
          console.error('写入生成历史失败（不影响生成结果）:', histErr)
        } else {
          trackedEvent = { genId: fallbackGenId, projectId: null, versionNumber: null }
        }
      }

      // M1：作品生成事实事件（每个版本一行；同项目多版本在 M2 评分时按项目封顶，
      // 一次电影测试的 V1/V3 不会变成三票）。tracker 内部吞错，绝不影响生成主流程。
      if (trackedEvent) {
        const contentDomain =
          (
            versionRow.inspiration_context as
              | { value_assessment?: { content_domain?: unknown } }
              | null
          )?.value_assessment?.content_domain
        await trackEvent(auth.supabase, auth.userId, {
          type: 'work_generate',
          targetType: 'generation',
          targetId: trackedEvent.genId,
          projectId: trackedEvent.projectId,
          contentDomain: typeof contentDomain === 'string' ? contentDomain : null,
          embedding: sampleEmbedding,
          topicExcerpt: topic,
          payload: {
            topic: topic.slice(0, 100),
            mode,
            version_number: trackedEvent.versionNumber,
            improve_direction: improveCtx?.direction ?? null,
          },
        })

        // 行为A：新增作品是画像变更事件（与删作品路径对称），立即异步重建，
        // 让用户创作完回到 dashboard 后尽快拿到基于新作品的推荐；
        // 走 afterResponse：serverless 下 void 的任务在响应后会被冻死，
        // 表现为"写了新作品推荐毫无反应"。失败不影响生成主流程
        // （下次进推荐页仍有按需补货兜底）。
        afterResponse(() => runBuild(auth.supabase, auth.userId, 'incremental').catch(() => {}))

        // ── Material Library 2.0 Phase 5：material_usages 反馈闭环 ──
        // 两个写入都在 generation_history 成功落库（trackedEvent 非 null）后触发，
        // 都用 void 前缀 fire-and-forget，不 await，失败静默降级。

        // P5-a：用户主动选择的素材 → selected_by_user=true + work_id 回填
        if (
          selectedMaterialIds.length > 0 &&
          creatorEnabled
        ) {
          void markSelectedByUser(
            auth.userId,
            trackedEvent.genId,
            selectedMaterialIds
          )
        }

        // P5-b：真正被注入 prompt 的素材 → actually_used=true + work_id 回填
        // 注入素材 = retrieved.materials 里被注入的那些（content 非空 + 截断 ≤ MAX_INJECT_TOTAL）
        if (creatorEnabled && retrieved.materials.length > 0) {
          const injectedIds = retrieved.materials
            .filter((m) => m.content.trim().length > 0)
            .slice(0, MAX_INJECT_TOTAL)
            .map((m) => m.materialId)
          if (injectedIds.length > 0) {
            void markActuallyUsed(
              auth.userId,
              trackedEvent.genId,
              injectedIds
            )
          }
        }
      }
    }

    // ── 生成成功：按本次真实 token 消耗结算（预扣多退少补）──
    // 放在最后：作品已经生成好了，记账失败绝不能让它变成"生成失败"。
    // 系统提示词 + 范文两次调用都要算，漏掉任何一次都是平台替用户买单。
    const totalUsage = addUsage(
      promptRes.usage ?? ZERO_USAGE,
      sampleRes.usage ?? ZERO_USAGE
    )
    let finalBalance: number | null = null
    if (billing) {
      const settledResult = await settleAiCost({
        supabase: billing.supabase,
        userId: billing.userId,
        refId: billing.refId,
        reserved: billing.reserved,
        usage: totalUsage,
        description: '正文生成结算',
      })
      settled = true
      finalBalance = settledResult.balance
      console.info(
        `[aiCost] 正文生成：预扣 ${settledResult.reserved} / 实际 ${settledResult.actual}` +
          `（补扣 ${settledResult.extraCharged}，退还 ${settledResult.refunded}）` +
          `｜输入(未命中)=${totalUsage.missTokens}, 输入(缓存)=${totalUsage.cachedTokens}, 输出=${totalUsage.outputTokens}`
      )
    }

    return NextResponse.json({
      systemPrompt,
      sampleText,
      generationId: resultGenId,
      // 回传最新余额：前端可直接刷新展示，省掉一次查询
      balance: finalBalance,
      projectId: resultProjectId,
      versionNumber: resultVersionNumber,
      improveDirection: improveCtx?.direction ?? null,
      improveNote: improveCtx ? improveNote : null,
      // 阶段 4 Work Agent：回传用户原始反馈原文（V2+ 才有，V1 为 null）
      // 前端 saveWork 时存入 localStorage.userFeedback，article 页展示用
      userFeedback: improveCtx?.userFeedback || null,
      blueprint,
      // 个人化证据：告诉前端"本次参考了什么"（不含 prompt 原文）
      personalization: {
        ...evidence,
        layers: Array.from(new Set(evidence.layers)),
      } satisfies PersonalizationEvidence,
      // 阶段 5：本次生效的创作者声明维度（供作品页展示"本次参考了你的这些偏好"）
      declarationTraits: declarationTraits.length > 0 ? declarationTraits : null,
      // 阶段四：本次登场角色快照（作品记录用，与角色库后续修改解耦）
      characters: characterBlock.used,
      // Creator Knowledge System Phase 3：本次真正注入的知识单元摘要。
      // 只记 layer 用户无从核对，回传原文才能验证「AI 到底有没有用上我的知识」。
      usedKnowledgeUnits: usedKnowledge,
    })
  } catch (error) {
    console.error('prompt-optimizer API 错误:', error)
    // 异常路径：预扣了但没结算 → 全额退。
    // 用 void + catch：退款失败不能覆盖原始的 500 原因，也不该拖慢错误响应。
    if (billing && !settled) {
      void refundAiCost({
        supabase: billing.supabase,
        userId: billing.userId,
        refId: billing.refId,
        amount: billing.reserved,
        reason: '生成流程异常中断，预扣全额退还',
      }).catch(() => {})
    }
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

export const POST = withAiDeadline(60, handlePost)
