// ============================================================
// AI 生成任务（跨页面共享模块）—— 创作进化系统阶段 2：两阶段编排
// 流程（登录用户）：
//   生成页提交 → ① 请求创作蓝图（约 3s）→ 结果页先展示蓝图 →
//   ② 自动携带蓝图请求 V1 正文（无需用户二次点击，"默认自动续写"）→
//   成功后同步写入 localStorage（作品 + 风格记忆）。
// 流程（游客 / 蓝图失败）：直接走 ②，与旧版单次生成完全一致。
// 「换个方向」：replanGeneration(id) 中断当前请求并用缓存参数重跑整条链路。
// 任务状态存内存，生成途中刷新浏览器会丢失任务（数据尚未落盘）。
// ============================================================

import { saveWork } from './works'
import { recordGeneration } from './styleMemory'
import { supabase } from './supabaseClient'
import type { CreativeBlueprint } from './creative/blueprint'
import type { FrozenPlan } from './creative/plan'
import type { NextActionKey } from './creative/diagnosis'
import type { PersonalizationEvidence } from './creative/creatorModel'
import type { CreationMode } from './creative/personalization'
import type { CharacterSnapshot } from './characters'
import type { InspirationAnalysis } from './creative/inspirationAnalyzer'

/** 发给 /api/prompt-optimizer 的请求参数 */
export interface GenerationParams {
  topic: string
  templateId?: string
  customIdentity?: string
  identityLabel?: string
  style: string
  wordCount: number
  category: string // 固定分类值或"自定义类型"
  customCategory: string // 自定义类型的品类文本
  projectId?: string // 创作进化系统阶段 3：传入则在该项目下新增版本（V2/V3…），否则新建项目
  // 阶段 5：定向迭代（点诊断卡方向）。传入后跳过蓝图阶段，直接在项目内按方向生成下一版
  improve?: {
    fromVersionId: string // 被迭代版本的真实行 id（pid::vN）
    direction: NextActionKey
    instruction?: string // custom 方向时用户的一句话修改指令；Work Agent 阶段 3 起为 formatFeedbackForPrompt 输出的完整优化蓝图
    // 阶段 4 Work Agent：用户原始反馈文本（与 instruction 不同）
    // instruction 是 AI 格式化后的优化蓝图，userFeedback 是用户说的原话
    // 用于 generation_history.user_feedback 字段溯源（V2+ 才有值，V1 为 null）
    userFeedback?: string
  }
  memory: {
    identities: string
    styles: string
    categories: string
    favoredExcerpts: string
  }
  // Creator Mode：'inspiration' 灵感模式 / 'creator' 我的模式；缺省由后端裁决（登录→creator）
  mode?: CreationMode
  // 阶段四：登场角色快照（最多 3 个）；improve 迭代时由文章页从原作品快照带入，保证人设延续
  characters?: CharacterSnapshot[]
  /**
   * 灵感场重构阶段 C：用户在生成页确认的"创作方案"（蓝图超集）。
   * 传入后跳过阶段①自动蓝图请求，直接携带该方案请求正文——
   * 方案驱动的身份/品类/文风/字数派生由 /api/prompt-optimizer 完成。
   * 不传则走旧链路（蓝图自动生成 / 游客直接生成）。
   */
  plan?: FrozenPlan
  /**
   * AI 灵感分析与转化系统：用户在 insight 态确认的灵感分析结果。
   * 透传到 /api/prompt-optimizer 落 generation_history.inspiration_context jsonb。
   * 数据沉淀用于未来个性化灵感推荐与创作者偏好学习。
   * 不传时 inspiration_context 为 null（老链路不受影响）。
   */
  inspirationContext?: InspirationAnalysis
}

/** 落盘时的创作参数（作品名 / 身份 / 文风 / 归类） */
export interface GenerationMeta {
  title: string
  identityLabel: string
  style: string
  category: string // 实际归类（含自定义类型文本）
}

/**
 * 任务状态机：
 * pending   = 蓝图构思中（登录用户阶段①）/ 游客直接撰写中
 * blueprint = 蓝图已就绪，正在按蓝图撰写 V1（页面可展示蓝图）
 * writing   = 正文撰写中（蓝图未走通时不会出现此态，保留给后续阶段）
 * done      = 完成
 * error     = 失败
 */
export type TaskStatus = 'pending' | 'blueprint' | 'writing' | 'done' | 'error'

export interface GenerationTask {
  status: TaskStatus
  blueprint?: CreativeBlueprint
  improveDirection?: NextActionKey // 阶段 5：定向迭代进行中时的方向（thinking 页展示）
  error?: string
}

// 模块级内存表：跨页面共享（同一 SPA 会话内跳转不丢失）
const tasks = new Map<string, GenerationTask>()
// 每个任务当前的 AbortController：用于「换个方向」中断进行中的请求
const controllers = new Map<string, AbortController>()
// 最近一次任务的入参缓存：支持 replanGeneration(id) 无参重跑
const lastInputs = new Map<string, { params: GenerationParams; meta: GenerationMeta }>()

/** 文章页查询任务状态 */
export function getTask(id: string): GenerationTask | undefined {
  return tasks.get(id)
}

/**
 * 发起生成任务并立即返回（不 await）。
 * 同一 id 再次调用会先中断旧请求（供「换个方向」/「再来一版」复用）。
 */
export function startGenerationTask(
  id: string,
  params: GenerationParams,
  meta: GenerationMeta
): void {
  // 中断同 id 的旧链路
  controllers.get(id)?.abort()

  const controller = new AbortController()
  controllers.set(id, controller)
  lastInputs.set(id, { params, meta })
  tasks.set(id, { status: 'pending' })

  void runPipeline(id, params, meta, controller.signal)
}

/**
 * 「换个方向」：中断当前请求并用缓存参数重跑整条链路。
 * 阶段 C：若缓存参数带冻结方案（plan），必须清除——
 *   "换个方向"的语义是重新分析生成全新方案，而非同方案再写一遍。
 *   同方案再写一遍走「再来一版」(handleRegenerateFeedback)。
 */
export function replanGeneration(id: string): boolean {
  const cached = lastInputs.get(id)
  if (!cached) return false
  const { plan: _plan, ...paramsWithoutPlan } = cached.params
  void _plan
  startGenerationTask(id, paramsWithoutPlan, cached.meta)
  return true
}

/** 内部：两阶段生成链路 */
async function runPipeline(
  id: string,
  params: GenerationParams,
  meta: GenerationMeta,
  signal: AbortSignal
): Promise<void> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`

    let blueprint: CreativeBlueprint | null = params.plan ?? null

    // ── 阶段 5：定向迭代模式——跳过蓝图构思（沿用项目蓝图），直接撰写下一版 ──
    if (params.improve) {
      tasks.set(id, { status: 'writing', improveDirection: params.improve.direction })
    } else if (params.plan) {
      // ── 阶段 C：用户已确认创作方案——跳过自动蓝图，直接进入正文撰写 ──
      tasks.set(id, { status: 'blueprint', blueprint: params.plan })
    } else if (session?.access_token) {
      // ── 阶段①：登录用户先获取创作蓝图 ──
      tasks.set(id, { status: 'pending' })
      try {
        const bpRes = await fetch('/api/creative/blueprint', {
          method: 'POST',
          headers,
          signal,
          body: JSON.stringify({
            topic: params.topic,
            templateId: params.templateId,
            customIdentity: params.customIdentity,
            identityLabel: params.identityLabel,
            style: params.style,
            wordCount: params.wordCount,
            category: params.category,
            customCategory: params.customCategory,
            memory: params.memory,
            // Creator Mode：灵感模式剥离全部隐性个人数据（蓝图与正文共用同一裁决）
            mode: params.mode,
            characters: params.characters ?? [],
          }),
        })
        if (bpRes.ok) {
          const bpData = await bpRes.json()
          blueprint = (bpData?.blueprint as CreativeBlueprint) ?? null
          if (blueprint) {
            // 蓝图就绪：页面会立即展示，同时我们不停顿地自动续写 V1
            tasks.set(id, { status: 'blueprint', blueprint })
          }
        } else {
          // 401/502 等：静默降级为无蓝图单次生成（产品决策：不让用户卡死）
          console.warn('蓝图生成失败，降级为单次生成:', bpRes.status)
        }
      } catch (e) {
        // abort 向上抛由外层统一处理；其他异常降级
        if ((e as Error)?.name === 'AbortError') throw e
        console.warn('蓝图请求异常，降级为单次生成:', e)
      }
    }

    // ── 阶段②：携带蓝图请求 V1 正文（游客 / improve 模式直接走这里） ──
    if (blueprint) {
      tasks.set(id, { status: 'writing', blueprint })
    }

    const res = await fetch('/api/prompt-optimizer', {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        generationId: id, // 与作品 id 一致，作为 generation_history 主键
        topic: params.topic,
        templateId: params.templateId,
        customIdentity: params.customIdentity,
        style: params.style,
        wordCount: params.wordCount,
        category: params.category,
        customCategory: params.customCategory,
        memory: params.memory,
        blueprint, // 无蓝图时为 null，后端走旧路径
        projectId: params.projectId, // 有值 = 在该项目下新增版本；无值且有蓝图 = 新建项目
        // 阶段 5：定向迭代（服务端从 fromVersionId 继承参数，忽略上面的表单字段）
        improve: params.improve ?? null,
        // Creator Mode：灵感/我的（improve 迭代由调用方传入原作品模式）
        mode: params.mode,
        // 阶段四：登场角色快照（与角色库解耦，保证作品可复现）
        characters: params.characters ?? [],
        // AI 灵感分析：透传到服务端落 generation_history.inspiration_context
        inspirationContext: params.inspirationContext ?? null,
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '生成失败，请重试')
    if (!data.systemPrompt || !data.sampleText) {
      throw new Error('AI 返回内容不完整，请重试')
    }

    // ── 本地存储：作品（含系统提示词 + 蓝图 + 版本归属）+ 风格记忆 ──
    // localStorage 行 id 始终用前端任务 id（保证 URL/轮询/老链接稳定）；
    // versionId 才是 generation_history 的真实行 id，反馈/版本接口使用它。
    saveWork({
      id,
      title: meta.title,
      content: data.sampleText,
      category: meta.category,
      created_at: new Date().toISOString(),
      identityLabel: meta.identityLabel,
      style: meta.style,
      systemPrompt: data.systemPrompt,
      blueprint: (data.blueprint as CreativeBlueprint | null) ?? blueprint ?? undefined,
      projectId: (data.projectId as string | null) ?? params.projectId ?? undefined,
      versionId: (data.generationId as string | null) ?? undefined,
      versionNumber:
        typeof data.versionNumber === 'number' ? data.versionNumber : undefined,
      improveDirection:
        (data.improveDirection as NextActionKey | null) ?? params.improve?.direction ?? undefined,
      improveNote:
        typeof data.improveNote === 'string' ? data.improveNote : null,
      // 阶段 4 Work Agent：用户原始反馈原文（V2+ 才有，V1 为 null）
      userFeedback:
        typeof data.userFeedback === 'string' ? data.userFeedback : null,
      personalization:
        data.personalization && typeof data.personalization === 'object'
          ? (data.personalization as PersonalizationEvidence)
          : undefined,
      // 阶段 5：本次生效的创作者声明维度（article 页展示"本次参考了你的这些偏好"）
      declarationTraits:
        Array.isArray(data.declarationTraits) && data.declarationTraits.length > 0
          ? (data.declarationTraits as Array<{ dimension: string; label: string; hard?: boolean }>)
          : undefined,
      // 阶段四：本次登场角色快照（article 页展示 + improve 迭代延续人设）
      characters:
        Array.isArray(data.characters) && data.characters.length > 0
          ? (data.characters as CharacterSnapshot[])
          : params.characters,
      // Creator Mode：优先用服务端裁决后的模式，回退入参/灵感（article 重生成据此沿用）
      mode:
        (data.personalization as PersonalizationEvidence | undefined)?.mode ??
        params.mode ??
        'inspiration',
    })
    recordGeneration({
      id,
      identityLabel: meta.identityLabel,
      style: meta.style,
      category: meta.category,
      sampleText: data.sampleText,
    })

    tasks.set(id, { status: 'done', blueprint: blueprint ?? undefined })
  } catch (e) {
    // 被「换个方向」/新任务中断：不写 error，避免旧链路覆盖新任务状态
    if ((e as Error)?.name === 'AbortError') return
    tasks.set(id, {
      status: 'error',
      error: e instanceof Error ? e.message : '网络错误，请重试',
    })
  } finally {
    // 仅当当前 controller 仍是自己时清理（新任务已替换则不动）
    if (controllers.get(id)?.signal === signal) {
      controllers.delete(id)
    }
  }
}
