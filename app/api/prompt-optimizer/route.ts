import { NextResponse } from 'next/server'
import { IDENTITY_TEMPLATES } from '@/lib/identityTemplates'
import { createServerClient } from '@/lib/supabaseServer'
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
import {
  formatStyleDimensions,
  parseStyleDimensions,
  recordDirectionSignal,
} from '@/lib/creative/styleLearning'
import {
  formatEditingProfileForPrompt,
  parseEditingProfile,
} from '@/lib/creative/editingMemory'
import {
  formatCreatorModel,
  type PersonalizationEvidence,
} from '@/lib/creative/creatorModel'
import {
  normalizeCreatorDeclaration,
  formatDeclarationForPrompt,
  isDeclarationEmpty,
  extractDeclarationTraits,
  type DeclarationTrait,
} from '@/lib/creative/creatorDeclaration'
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
 * 混合两个向量：result[i] = weightA * a[i] + weightB * b[i]
 * 口径：0.7 * 主题输入向量 + 0.3 * 用户风格向量，兼顾内容相关性与个人风格
 */
function mixVectors(a: number[], b: number[], weightA: number, weightB: number): number[] {
  const dim = Math.max(a.length, b.length)
  const result = new Array(dim).fill(0)
  for (let i = 0; i < dim; i++) {
    result[i] = (a[i] ?? 0) * weightA + (b[i] ?? 0) * weightB
  }
  return result
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
 * 可选鉴权：带有效 Bearer token 则返回用户上下文，否则返回 null（游客仍可生成）。
 * 登录用户生成成功后自动写入 generation_history；游客走反馈接口的延迟创建兜底。
 */
async function authenticateOptional(req: Request) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) return null

  const supabase = createServerClient(token)
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token)
  if (error || !user) return null

  return { supabase, userId: user.id }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RequestBody

    // 可选鉴权：登录用户生成成功后自动记录历史
    const auth = await authenticateOptional(req)

    // ── 阶段 3：usage_filter 推断 ──
    // 优先级：improve 模式 prevUsageTags > blueprint.usage_tag > blueprint.content_type 映射 > null
    // usage_tag 是 AI 方案直接推断的，比 content_type → usage 映射更准确
    const CATEGORY_TO_USAGE: Record<string, UsageTag> = {
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
    function inferUsageFilter(
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
            ...analysis.strengths.slice(0, 3).map((s) => `  [优势] ${s}`),
            ...analysis.problems.slice(0, 3).map((s) => `  [问题] ${s}`),
            ...analysis.suggestions.slice(0, 3).map((s) => `  [建议] ${s}`),
          ].join('\n')
        : '  （暂无上一版诊断，请凭专业判断重写）'
      // custom 方向：以用户自己的一句话指令为最高优先级改法；其余方向用诊断中的该方向建议
      const directionHow = isCustom
        ? improveInstruction
        : analysis?.nextActions[improveDirection as NextActionKey] ||
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

    // ── 登录用户：查询风格卡 + 创作者人格 + 向量检索参考内容 ──
    // 嵌入/检索失败不阻断生成主流程，仅降级为无参考内容
    let styleText = '' // 拼入 prompt 的风格描述文本
    let referenceContent = '' // 检索到的历史参考素材
    let historyWorksText = '' // Creator Mode：该用户同主题历史作品真实摘录
    let historyWorkCount = 0 // 实际引用的历史作品数（身份声明中使用真实数字）
    let creatorText = '' // Creator Model 人格块（开关关闭时为空）
    let creatorAvoid: string[] = [] // 排斥元素硬禁忌（写进生成硬规则）
    let styleVec: number[] | null = null // 用户风格向量（第七阶段：本篇一致度计算用）
    let declarationTraits: DeclarationTrait[] = [] // 阶段 5：本次生效的声明维度（回传前端展示）

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
          })
        | null

      if (styleProfile) {
        // 构建风格描述段（拼入 prompt，让 AI 参考用户个人风格）
        const toneTags = styleProfile.tone_tags?.length
          ? styleProfile.tone_tags.join('、')
          : '暂无'
        // 阶段 5：从反馈/定稿/选方向行为学习出的五维画像（样本不足时为空串）
        const learnedDims = formatStyleDimensions(styleProfile.style_dimensions)
        const dimState = parseStyleDimensions(styleProfile.style_dimensions)
        evidence.dimensionSamples = dimState.samples
        if (learnedDims) evidence.layers.push('五维风格画像')
        styleText = `\n\n【用户的创作风格特征】\n语气：${toneTags}\n节奏：${styleProfile.pace_preference}\n常用开头：${styleProfile.common_opening}\n平均长度：${styleProfile.avg_length} 字/篇\n请尽量体现这些风格特征。${learnedDims ? `\n\n${learnedDims}` : ''}`

        // 个人化引擎：创作者人格块（用户可在生成页显式关闭）
        if (creatorEnabled) {
          const block = formatCreatorModel(styleProfile)
          creatorText = block.text
          creatorAvoid = block.avoid
          evidence.layers.push(...block.layers)
          // 第七阶段：本次采用的创作者特征（DNA 真实统计，供作品页"本次作品采用"展示）
          evidence.traits = block.traits
        }

        // 创作者声明（访谈结果，用户主动表达，优先级 > AI 推断的 CreatorReport）
        const declaration = normalizeCreatorDeclaration(styleProfile.creator_declaration)
        if (!isDeclarationEmpty(declaration)) {
          const declText = formatDeclarationForPrompt(declaration)
          if (declText) {
            creatorText = (creatorText ? creatorText + '\n' : '') + declText
            evidence.layers.push('创作者声明')
            // avoid_preference 与 avoid_elements 合并（硬约束，string[] 去重 push）
            if (
              declaration.avoid_preference &&
              !creatorAvoid.includes(declaration.avoid_preference)
            ) {
              creatorAvoid = [...creatorAvoid, declaration.avoid_preference]
            }
            // 收集本次生效声明维度，回传前端展示
            declarationTraits = extractDeclarationTraits(declaration)
          }
        }

        // AI 协作修改（P5）：编辑偏好记忆注入（samples<2 或无有效偏好时为空串）
        const editingState = parseEditingProfile(styleProfile.editing_profile)
        const editingText = formatEditingProfileForPrompt(editingState)
        if (editingText) {
          creatorText = (creatorText ? creatorText + '\n' : '') + editingText
          evidence.layers.push('修改偏好记忆')
          // 高置信 avoid 偏好并入生成硬规则（硬约束，string[] 去重 push）
          for (const p of editingState.preferences) {
            if (p.type === 'avoid' && p.sourceCount >= 2 && !creatorAvoid.includes(p.statement)) {
              creatorAvoid = [...creatorAvoid, p.statement]
            }
          }
        }
      }

      // 2) 生成主题文本的嵌入向量（用于向量检索）
      const topicEmbedding = await generateEmbedding(topic)

      // 3) 向量检索
      if (topicEmbedding) {
        styleVec = parseVector(styleProfile?.style_vector)

        // 素材库（match_scripts）使用混合向量：素材库本来就是用户主动存的通用素材，
        // 兼顾主题相关性(0.7)与个人风格偏好(0.3)，污染风险低
        const materialQueryVec = styleVec
          ? mixVectors(topicEmbedding, styleVec, 0.7, 0.3)
          : topicEmbedding

        // ── 阶段 3：usage_filter 智能检索（两阶段：先按 usage 过滤召回；不足则回退纯向量）──
        // 优先级：improve 模式 prevUsageTags > blueprint.usage_tag > blueprint.content_type 映射
        const bpEarly = improveCtx
          ? improveCtx.blueprint
          : normalizeBlueprint(body.blueprint)
        const currentContentType = improveCtx
          ? ((improveCtx.blueprint as any)?.content_type ?? '')
          : ((bpEarly as any)?.content_type ?? '')
        const currentUsageTag = improveCtx
          ? ((improveCtx.blueprint as any)?.usage_tag as string | undefined)
          : ((bpEarly as any)?.usage_tag as string | undefined)
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

        const RPC_PARAMS_BASE = {
          query_embedding: materialQueryVec,
          match_count: 5,
          p_user_id: auth.userId,
        }

        // 第一阶段：有 usage_filter 时带 filter 检索（过滤掉 usage 不匹配的素材）
        let matches: { content?: string; similarity?: number }[] | null = null
        let matchErr: unknown = null
        if (usageFilter) {
          const r = await auth.supabase.rpc('match_scripts', {
            ...RPC_PARAMS_BASE,
            p_usage_filter: usageFilter,
          })
          matchErr = r.error
          matches = r.data as { content?: string; similarity?: number }[] | null
        }

        // 第二阶段兜底：无 filter / 召回不足 3 条 → 纯向量检索（避免素材库无 knowledge 时召回过少）
        const MIN_FILTERED_COUNT = 3
        if (
          (!usageFilter || !matches || matches.length < MIN_FILTERED_COUNT) &&
          !matchErr
        ) {
          const r = await auth.supabase.rpc('match_scripts', RPC_PARAMS_BASE)
          if (!r.error && Array.isArray(r.data)) {
            // 第二阶段结果优先（覆盖）：纯向量召回保底不空
            matches = r.data as { content?: string; similarity?: number }[]
          }
        }

        if (matchErr) {
          console.error('向量检索失败（不影响生成）:', matchErr)
        } else if (matches && Array.isArray(matches) && matches.length > 0) {
          evidence.materialCount = matches.length
          evidence.layers.push('素材库相关参考')
          referenceContent = matches
            .map(
              (m: { content?: string; similarity?: number }) =>
                `（相似度 ${((m.similarity ?? 0) * 100).toFixed(0)}%）${(m.content ?? '').slice(0, 500)}`
            )
            .join('\n---\n')
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
    const bp = blueprint as (CreativeBlueprint & { content_type?: string; language_style?: { pace?: string; mood?: string; expression?: string } }) | null

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
${memBlockFirst ? `\n${memBlockFirst}` : ''}${styleText}${effectiveCreatorText}${characterBlock.text}${referenceContent ? `\n\n【用户素材库中与主题相关的参考内容】\n${referenceContent}` : ''}${historyWorksBlock}${priorityBlock}

要求：
1. 严格按 5 个板块结构输出
2. 【任务要求】需贴合上述"内容品类"的典型结构、节奏与受众预期；如历史记忆与本次表单冲突，以本次表单为准${bp ? '\n3. 【创作要素优先级】（冲突时高优先级覆盖低优先级，不可颠倒）：\n   ① 用户已确认的创作方案（内容类型/方向/视角/叙事结构/字数）——最高；\n   ② 该创作者的人格与历史风格——只决定"怎么表达"，不得改变第①条的方向；\n   ③ 素材库相关参考——只供事实与细节；\n   ④ 平台通用创作经验——兜底。\n   角色定位中的"身份"必须是"创作视角"（如何切入），不得写成"XX人/XX博主"等身份标签。' : ''}
${bp ? '4' : '3'}. 【字数硬性限制】板块必须明确写出"总字数严格控制在 ${wordCount} 字（±10%，即 ${Math.floor(wordCount * 0.9)}-${Math.ceil(wordCount * 1.1)} 字）"
${bp ? '5' : '4'}. 【禁止事项】板块至少列 3 条${creatorEnabled ? `\n${bp ? '6' : '5'}. 【禁止事项】必须包含任务隔离硬规则：${taskMode === 'new' ? '不得把历史作品中的具体角色名、剧情桥段、世界观设定带入本次创作；只允许借鉴抽象的语言节奏、叙事方式。' : '继续创作模式下，只允许继承本项目既有的角色/剧情/世界观，不得引入其他历史作品的具体内容。'}` : ''}
${bp ? '6' : '5'}. 语言精炼、指令清晰，可直接复制给大模型使用${bpPromptText}${improvePromptText ? `\n\n请为这次"${NEXT_ACTION_META.find((m) => m.key === improveCtx?.direction)?.label}"定向迭代重建系统提示词，在【任务要求】中体现该迭代方向与下方诊断结论。${improvePromptText}` : ''}`,
      },
    ]

    const promptRes = await fetch(
      'https://api.deepseek.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: promptBuilderMessages,
          temperature: 0.3,
          max_tokens: 1500,
        }),
      }
    )

    if (!promptRes.ok) {
      console.error('系统提示词生成失败:', await promptRes.text())
      return NextResponse.json(
        { error: '系统提示词生成失败，请稍后重试' },
        { status: 500 }
      )
    }

    const promptData = await promptRes.json()
    const systemPrompt =
      promptData?.choices?.[0]?.message?.content

    if (typeof systemPrompt !== 'string' || systemPrompt.trim().length === 0) {
      return NextResponse.json(
        { error: '系统提示词生成失败，请稍后重试' },
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
${memBlockSecond ? `\n${memBlockSecond}` : ''}${effectiveCreatorText}${characterBlock.text}${historyWorksBlock}

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
    const sampleRes = await fetch(
      'https://api.deepseek.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: sampleMessages,
          temperature: 0.8,
          max_tokens: Math.ceil(wordCount * 1.1 * 2) + (improveCtx ? 400 : 0),
          ...(improveCtx ? { response_format: { type: 'json_object' as const } } : {}),
        }),
      }
    )

    if (!sampleRes.ok) {
      console.error('范文生成失败:', await sampleRes.text())
      return NextResponse.json(
        { error: '范文生成失败，请稍后重试' },
        { status: 500 }
      )
    }

    const sampleData = await sampleRes.json()
    const rawSample: string = sampleData?.choices?.[0]?.message?.content ?? ''

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
        }
      }
    }

    return NextResponse.json({
      systemPrompt,
      sampleText,
      generationId: resultGenId,
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
    })
  } catch (error) {
    console.error('prompt-optimizer API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
