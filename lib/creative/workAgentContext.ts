// ============================================================
// Work Agent Context（上下文装配器）—— 仅服务端
//
// 存在意义：回答"AI 凭什么知道我们在改哪篇文章、这篇文章现在什么毛病、
// 用户最初想写什么、这是谁的文风、他自己的素材里有什么"。
//
// 为什么必须单点：
//   改造之前，补丁链路（patchEngine）只拿到「用户一句话 + 正文」，
//   导致修改结果变成统一 AI 文风——这是局部修改最大的失败模式。
//   三个阶段（澄清/提案/补丁）必须携带同一份上下文，任何一处自己拼 prompt
//   都会造成口径漂移：AI 在澄清阶段认的问题，到了补丁阶段却被忽略。
//
// 设计原则：
//   1. 所有数据源失败都降级为空块 + degraded 记录，绝不抛错中断共创
//   2. 每个块都有硬预算（正文/素材/外部），防止 prompt 撑爆导致 token 不可控
//   3. 素材优先于 AI 编造：retrieveMaterials 的结果永远排在外部知识之前
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabaseServer'
import { normalizeProblem, formatProblemForPrompt } from './problemFormat'
import { fetchCreatorStyleProfile } from './styleProfileRepo'
import { formatCreatorModel } from './creatorModel'
import { parseEditingProfile, formatEditingProfileForPrompt } from './editingMemory'
import { parseDiagnosis } from './diagnosisMeta'
import { splitParagraphs } from './patchEngine'
import { retrieveMaterials, MAX_INJECT_TOTAL } from '@/lib/material/retrieval'
import {
  MAX_EXTERNAL_ITEMS,
  type ExternalKnowledgeItem,
  type WorkAgentContext,
  type WorkAgentKnowledgeSource,
} from './workAgent'

// ── Token 预算（改动这些常量前先看本文件顶部的原则 2）──────

/** 注入上下文的正文上限（超出截断；chapter 级长文靠诊断而非全文工作） */
export const WORK_CONTENT_LIMIT = 6000
/** 单条素材注入上限 */
export const MATERIAL_SNIPPET_LIMIT = 400
/** 注入 prompt 的素材条数上限（小于 MAX_INJECT_TOTAL，给对话留预算） */
export const CONTEXT_MATERIAL_LIMIT = 5
/** 单条外部知识注入上限 */
export const EXTERNAL_SNIPPET_LIMIT = 300

export interface AssembleContextInput {
  client: ReturnType<typeof createServerClient>
  userId: string
  /** 基底版本行（必须从服务端查出，不信任客户端带来的正文） */
  versionRow: {
    id: string
    topic?: string | null
    sample_text?: string | null
    blueprint?: unknown
    analysis?: unknown
    created_at?: string | null
    version_number?: number | null
  }
  /** 本轮用户诉求的意图词（素材召回的软排序信号，如"案例引用"；不参与向量构造） */
  intentHint?: string
  /** 外部知识源（可选；本期默认不传，接口先行） */
  externalSources?: WorkAgentKnowledgeSource[]
  /** 是否跳过素材召回（如单轮聊天已知不需要案例） */
  skipMaterials?: boolean
}

/**
 * 装配 Work Agent 完整上下文。任何子步骤失败都降级而非抛出。
 *
 * 调用时机：阶段1 澄清开始前调用一次并缓存，同一会话的三个阶段复用同一份，
 * 保证「AI 认出的问题」与「AI 实际改的地方」是同一套认知。
 */
export async function assembleWorkContext(
  input: AssembleContextInput
): Promise<WorkAgentContext> {
  const { client, userId, versionRow } = input
  const degraded: string[] = []

  const rawContent = typeof versionRow.sample_text === 'string' ? versionRow.sample_text : ''
  const segments = splitParagraphs(rawContent)
  const topic = versionRow.topic?.trim() || ''

  // ── 1. 作品本体（唯一必需项）──
  const work: WorkAgentContext['work'] = {
    title: topic || '未命名作品',
    topic,
    versionNumber: Number(versionRow.version_number ?? 0) || 0,
    versionId: versionRow.id,
    createdAt: versionRow.created_at ?? '',
    content: segments.join('\n\n').slice(0, WORK_CONTENT_LIMIT),
    segmentCount: segments.length,
  }
  if (segments.join('\n\n').length > WORK_CONTENT_LIMIT) {
    degraded.push('正文过长已截断展示')
  }

  // ── 2. AI 五维诊断（已诊断则有值；未诊断降级为空，不阻塞）──
  const diagnosis = parseDiagnosis(versionRow.analysis)

  // ── 3. 原始创作目标（blueprint.problem_understanding）——防止迭代跑偏的最后一道锁 ──
  const goal = extractOriginalGoal(versionRow.blueprint)

  // ── 4+5. Creator Profile + 编辑偏好（同一次 style_profiles 查询）──
  let creator = ''
  let editing = ''
  try {
    const profile = await fetchCreatorStyleProfile(client, userId)
    if (profile) {
      const block = formatCreatorModel(profile as never)
      creator = block.text
      if (!creator) degraded.push('尚未生成创作者画像')
      // editing_profile 已含在 FULL 列集合里；旧库缺该列时 parse 返回空画像
      editing = formatEditingProfileForPrompt(parseEditingProfile(profile.editing_profile))
    } else {
      degraded.push('尚未生成创作者画像')
    }
  } catch (e) {
    console.error('WorkAgent：画像装配失败（降级为无画像）:', e)
    degraded.push('创作者画像读取失败')
  }

  // ── 6. 个人素材库（用户自己有什么案例/数据/金句）──
  const materials: WorkAgentContext['materials'] = []
  if (!input.skipMaterials && topic) {
    try {
      const { materials: recalled, meta } = await retrieveMaterials(
        client as unknown as SupabaseClient,
        {
          userId,
          currentTopic: topic,
          currentIntent: input.intentHint,
        },
        { reasonMode: 'template', autoLimit: CONTEXT_MATERIAL_LIMIT }
      )
      const limit = Math.min(CONTEXT_MATERIAL_LIMIT, MAX_INJECT_TOTAL)
      for (const m of recalled.slice(0, limit)) {
        materials.push({
          title: m.materialType || '素材',
          content: m.content.slice(0, MATERIAL_SNIPPET_LIMIT),
          reason: m.relevanceReason,
        })
      }
      if (meta.degraded) degraded.push('素材召回降级（向量服务不可用）')
    } catch (e) {
      // 素材召回失败不得中断共创：宁可 AI 没有素材，也不能让用户卡在 loading
      console.error('WorkAgent：素材召回失败（降级为无素材）:', e)
      degraded.push('素材库召回失败')
    }
  }

  // ── 7. 外部知识（本期为预留接口；实现未接入时恒定返回空）──
  const external: ExternalKnowledgeItem[] = []
  if (input.externalSources?.length && topic) {
    for (const src of input.externalSources) {
      if (!src.enabled) continue
      try {
        const items = await src.search(input.intentHint || topic, { limit: MAX_EXTERNAL_ITEMS })
        for (const it of items.slice(0, MAX_EXTERNAL_ITEMS - external.length)) {
          external.push({ ...it, snippet: it.snippet.slice(0, EXTERNAL_SNIPPET_LIMIT) })
        }
      } catch (e) {
        console.error(`WorkAgent：外部知识源 ${src.id} 失败（忽略）:`, e)
        degraded.push(`外部知识源 ${src.label} 不可用`)
      }
      if (external.length >= MAX_EXTERNAL_ITEMS) break
    }
  }

  return { work, diagnosis, goal, creator, editing, materials, external, degraded }
}

/**
 * 从 blueprint jsonb 中提取「用户原始创作目标」。
 *
 * 优先级：problem_understanding（AI 对用户目标的最终理解）> topic > clarifications 原始回答。
 * 取 problem_understanding 而非 clarifications 的原因：clarifications 是用户的原话（可能零散），
 * problem_understanding 是系统已经收敛过的目标定义，作为"不能偏离"的锚点更稳定。
 */
export function extractOriginalGoal(blueprint: unknown): string {
  if (typeof blueprint !== 'object' || blueprint === null) return ''
  const o = blueprint as Record<string, unknown>
  const pu = normalizeProblem(o.problem_understanding ?? o.problem)
  if (pu) return formatProblemForPrompt(pu)

  const fallback: string[] = []
  const topic = typeof o.topic === 'string' ? o.topic.trim().slice(0, 200) : ''
  if (topic) fallback.push(`创作主题：${topic}`)
  const clarifications = Array.isArray(o.clarifications) ? o.clarifications : []
  const answers = clarifications
    .map((c) => {
      if (typeof c !== 'object' || c === null) return ''
      const r = c as Record<string, unknown>
      return typeof r.answer === 'string' ? r.answer.trim().slice(0, 100) : ''
    })
    .filter(Boolean)
    .slice(0, 4)
  if (answers.length > 0) fallback.push(`用户澄清补充：${answers.join('；')}`)
  return fallback.join('\n')
}

/**
 * 把上下文渲染为注入 LLM 的文本块（三个阶段共用，保证口径一致）。
 *
 * 顺序刻意固定：「作品 → 诊断 → 目标 → 创作者画像 → 编辑偏好 → 素材 → 外部」，
 * 让 LLM 先建立"在讨论哪篇"，再看"有什么问题"，最后才是"用什么素材"。
 *
 * @param opts.includeContent 是否携带正文本身，默认 true。
 *   补丁链路必须传 false：generateEditPatches 自己带了编号完整段落列表
 *   （LLM 需要它做 1-based 定位），此处再放一份截断正文是纯重复，只烧 token。
 */
export function formatContextForPrompt(
  ctx: WorkAgentContext,
  opts: { includeContent?: boolean } = {}
): string {
  const blocks: string[] = []
  const includeContent = opts.includeContent !== false

  blocks.push(
    [
      '【正在讨论的作品】',
      `标题：${ctx.work.title}`,
      `版本：V${ctx.work.versionNumber}（共 ${ctx.work.segmentCount} 段）`,
      ctx.work.createdAt ? `生成时间：${ctx.work.createdAt.slice(0, 10)}` : '',
      includeContent ? '' : null,
      includeContent ? '--- 正文 ---' : null,
      includeContent ? ctx.work.content : null,
      includeContent ? '--- 正文结束 ---' : null,
    ]
      .filter((v): v is string => typeof v === 'string')
      .join('\n')
  )

  if (ctx.diagnosis) {
    const d = ctx.diagnosis
    const dimLines = Object.entries(d.dimensions)
      .map(([k, v]) => `  - ${k}：${v.level}/5 ${v.comment}`.slice(0, 200))
      .join('\n')
    blocks.push(
      [
        '【AI 作品诊断（本次修改必须优先回应这里指出的问题）】',
        dimLines,
        d.strengths.length ? `优势：${d.strengths.join('；')}` : '',
        d.problems.length ? `问题：${d.problems.join('；')}` : '',
        d.suggestions.length ? `建议：${d.suggestions.join('；')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 2000)
    )
  }

  if (ctx.goal) {
    blocks.push(`【用户原始创作目标（不可偏离的锚点）】\n${ctx.goal.slice(0, 1200)}`)
  }

  if (ctx.creator) {
    blocks.push(ctx.creator.slice(0, 2000))
  }

  if (ctx.editing) {
    blocks.push(ctx.editing.slice(0, 1200))
  }

  if (ctx.materials.length > 0) {
    blocks.push(
      [
        `【用户个人素材库（优先使用这些真实素材，禁止凭记忆编造案例/数据）】`,
        ...ctx.materials.map((m, i) => `  ${i + 1}. [${m.title}] ${m.content}`),
      ].join('\n')
    )
  }

  if (ctx.external.length > 0) {
    blocks.push(
      [
        '【外部知识（辅助事实与数据，须标注来源，不得直接照抄表述）】',
        ...ctx.external.map(
          (e, i) => `  ${i + 1}. [${e.source}] ${e.title}：${e.snippet}`
        ),
      ].join('\n')
    )
  }

  return blocks.join('\n\n')
}
