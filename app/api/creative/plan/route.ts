// ============================================================
// POST /api/creative/plan —— 灵感场生成重构：生成前的"AI 创作方案"
//
// 与旧 /api/creative/blueprint 的区别：
//   1. 可选鉴权：游客也能获得系统模式方案（第一次体验无登录墙）；
//   2. 入参只要 topic（+mode/角色/显式提示），不再强制身份/字数/品类；
//   3. 一次调用产出完整方案（内容类型+理由 / 3 方向 / 视角 / 结构 /
//      语言风格 / 字数档 / 个性化证据句）；
//   4. 灵感模式零数据库调用零检索成本；我的模式装配 DNA + 真实旧作。
//
// LLM 失败返回 502，前端降级为手动参数生成，不阻断生成主流程。
// ============================================================

import { NextResponse } from 'next/server'
import { CATEGORIES } from '@/lib/constants'
import { rateLimit } from '@/lib/rateLimit'
import { authenticateWithToken, generateEmbedding } from '@/lib/storage'
import {
  buildPlanEvidence,
  generatePlan,
  type GeneratePlanInput,
} from '@/lib/creative/plan'
import {
  judgeIntentClarity,
  normalizeClarifications,
  type ClarificationAnswer,
} from '@/lib/creative/intentClarity'
import {
  normalizeInspirationAnalysis,
  formatInspirationForPrompt,
} from '@/lib/creative/inspirationAnalyzer'
import { formatStyleDimensions } from '@/lib/creative/styleLearning'
import { formatCreatorModel } from '@/lib/creative/creatorModel'
import { resolveMode, buildCreatorIdentity } from '@/lib/creative/personalization'
import { adoptRecommendation } from '@/lib/creative/interest/adopt'
import { fetchCreatorStyleProfile } from '@/lib/creative/styleProfileRepo'
import {
  sanitizeCharacterInput,
  formatCharactersForPrompt,
} from '@/lib/characters'
import type { createServerClient } from '@/lib/supabaseServer'

export const maxDuration = 60 // 输出含问题理解 + 三方向方案，与 prompt-optimizer 同口径
export const dynamic = 'force-dynamic'

// 文本类 LLM 接口限流口径：10 次/分钟（与项目硬约束一致）
const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000

type SupabaseServerClient = ReturnType<typeof createServerClient>

interface RequestBody {
  topic?: unknown
  mode?: unknown
  characters?: unknown
  hints?: unknown // { contentType?, style? } 高级设置中的用户显式补充
  /**
   * 阶段 2：用户澄清回答。
   * - undefined / 空数组：进入阶段 A（判定），返回 { stage: 'clarify', questions } 或 { stage: 'plan', plan }
   * - 非空数组：进入阶段 B（生成），把 answers 作为硬约束注入 generatePlan
   */
  clarifications?: unknown
  /** 阶段 2：用户主动跳过澄清，强制走 plan 生成路径，不判定 */
  skip_clarify?: unknown
  /**
   * AI 灵感分析：用户在 insight 态确认后的 InspirationAnalysis。
   * 转文本注入 generatePlan prompt，让 plan 延续灵感分析的结论。
   * undefined 时：走原 plan 生成路径，无行为变化。
   */
  inspiration_context?: unknown
  /**
   * WF1 推荐采纳回流：请求来自推荐卡点击时携带（/generate 从 URL 透传）。
   * 方案生成成功即视为"采纳"：卡片离队 + recommend_adopt 事件（1.5 权重）
   * + 触发增量重建。无此字段 = 普通生成路径，零影响。
   */
  rec_id?: unknown
}

function str(v: unknown, maxLen: number): string {
  return typeof v === 'string' ? v.trim().slice(0, maxLen) : ''
}

/** head count：只取计数不取行 */
async function countWorks(supabase: SupabaseServerClient, userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('generation_history')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
  if (error) {
    console.error('plan 统计历史作品失败:', error.message)
    return 0
  }
  return count ?? 0
}

/**
 * 我的模式：装配风格卡 + 创作者人格文本（与 blueprint 接口同口径，
 * 保证"方案阶段的 AI"和"正文阶段的 AI"对用户的理解一致）。
 */
function buildStyleProfileText(profile: Record<string, unknown> | null): string {
  if (!profile) return ''
  const toneTags =
    Array.isArray(profile.tone_tags) && profile.tone_tags.length
      ? profile.tone_tags.filter((x): x is string => typeof x === 'string').join('、')
      : '暂无'
  const learnedDims = formatStyleDimensions(profile.style_dimensions)

  let text = `【用户的创作风格特征】
语气：${toneTags}
节奏：${typeof profile.pace_preference === 'string' ? profile.pace_preference : '未知'}
常用开头：${typeof profile.common_opening === 'string' ? profile.common_opening : '未知'}
平均长度：${typeof profile.avg_length === 'number' ? profile.avg_length : 0} 字/篇
请在三个方向的设计中体现这些风格特征（方向可有探索性，但推荐方向必须贴合）。${learnedDims ? `\n${learnedDims}` : ''}`

  // 创作者人格：母题偏好影响方向选取；排斥元素是所有方向的硬禁忌
  const block = formatCreatorModel(profile)
  if (block.text) {
    text += `\n${block.text}\n请在方向的选题切入、Hook 与核心冲突上体现该创作者的母题偏好；排斥元素不得出现在任何方向的任何环节。`
  }
  return text
}

export async function POST(req: Request) {
  try {
    // ── 强制鉴权：游客不可使用方案生成 ──
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const auth = token ? await authenticateWithToken(token) : null
    if (!auth) {
      return NextResponse.json(
        { error: '请先登录后再生成方案' },
        { status: 401 }
      )
    }

    const body = (await req.json().catch(() => ({}))) as RequestBody
    const topic = str(body.topic, 500)
    if (!topic) {
      return NextResponse.json({ error: '请填写创作主题' }, { status: 400 })
    }

    // 模式裁决：游客强制灵感模式（后端不信任前端登录态声明）
    const mode = resolveMode(body.mode, !!auth)

    // ── 阶段 2：意图澄清两阶段路由 ──
    // 不传 clarifications 且不跳过 → 阶段 A：先判定是否需要澄清
    // 传非空 clarifications → 阶段 B：把回答注入 plan 生成
    // skip_clarify=true → 用户主动跳过，强制走 plan 生成
    const skipClarify = body.skip_clarify === true
    const clarifications = normalizeClarifications(body.clarifications)

    if (!skipClarify && clarifications.length === 0) {
      // ── 阶段 A：判定意图清晰度 ──
      // 失败时静默降级为"不澄清直接生成"，保证游客和稳定用户无感知
      const clarity = await judgeIntentClarity({ topic })
      if (clarity && clarity.needs_clarification && clarity.questions.length > 0) {
        return NextResponse.json({
          stage: 'clarify',
          questions: clarity.questions,
          inferred: clarity.inferred,
          reason: clarity.reason,
        })
      }
      // 判定不需要澄清 / 判定失败：继续走原 plan 生成路径（下文）
    }
    // clarifications.length > 0 或 skip_clarify=true 时进入阶段 B：生成 plan

    // 高级设置：用户本次显式输入（任何模式下都是最高优先级）
    const hintsRaw =
      typeof body.hints === 'object' && body.hints !== null
        ? (body.hints as Record<string, unknown>)
        : {}
    const hints = {
      contentType: str(hintsRaw.contentType, 30),
      style: str(hintsRaw.style, 500),
    }

    // ── 登场角色：显式内容资产，两个模式都保留并约束方案 ──
    const characters = sanitizeCharacterInput(body.characters)
    const characterBlock = formatCharactersForPrompt(characters)

    // ── 我的模式装配：风格卡 + 真实证据 + 近期旧作（任一环节失败静默降级）──
    let creatorIdentityText = ''
    let styleProfileText = ''
    let evidenceText = ''
    let recentWorksText = ''

    if (auth && mode === 'creator') {
      const { supabase, userId } = auth

      // 风格卡（不带 1024 维风格向量：方案阶段只需要可读画像，不需要风格混合检索）
      const profile = await fetchCreatorStyleProfile(supabase, userId, false)

      // 真实计数（证据句数字的合法来源之一）
      const worksCount = await countWorks(supabase, userId)

      // 近期同主题旧作：主题 embedding → match_user_works（失败降级为空）
      let recentTopics: string[] = []
      const topicEmbedding = await generateEmbedding(topic)
      if (topicEmbedding) {
        const { data: works, error: worksErr } = await supabase.rpc('match_user_works', {
          query_embedding: topicEmbedding,
          match_count: 8,
          p_user_id: userId,
        })
        if (worksErr) {
          console.error('方案阶段历史作品检索失败（不影响方案生成）:', worksErr.message)
        } else if (Array.isArray(works) && works.length > 0) {
          recentTopics = works
            .map((w: { topic?: string }) => (typeof w.topic === 'string' ? w.topic : ''))
            .filter(Boolean)
          recentWorksText =
            '【该创作者与本主题相近的真实旧作（体会其切入角度、句式与节奏，用于让推荐方向更像 ta，禁止照抄内容）】\n' +
            works
              .slice(0, 3)
              .map(
                (w: { topic?: string; sample_text?: string; similarity?: number }, i: number) =>
                  `旧作${i + 1}《${(w.topic ?? '未命名').slice(0, 60)}》（相似度 ${((w.similarity ?? 0) * 100).toFixed(0)}%）\n${(w.sample_text ?? '').slice(0, 300)}`
              )
              .join('\n---\n')
        }
      }

      // 证据清单：DNA 真实计数 + 近期主题（personal_reason 防幻觉的唯一数据源）
      evidenceText = buildPlanEvidence({
        report: profile?.creator_report,
        worksCount,
        recentTopics,
      }).text

      // 长期专属伙伴身份锚定（与蓝图/正文接口同口径）
      // 方案生成阶段默认按"新独立任务"注入任务隔离边界（用户尚未选 projectId）
      const identity = buildCreatorIdentity('creator', 'new', worksCount)
      creatorIdentityText = identity
        ? `${identity.forWriter}\n\n本次任务是先为这位创作者"设计创作方案"而不是直接写正文：选题切入、方向选择、Hook 与冲突设计都要像 ta 本人会自然生长出来的样子，而不是平台通用模板。`
        : ''

      styleProfileText = buildStyleProfileText(profile)
    }

    // ── AI 灵感分析：从 body 取出并转文本注入 plan（让 plan 延续灵感分析结论）──
    const inspirationAnalysis = normalizeInspirationAnalysis(body.inspiration_context)
    const inspirationContextText = inspirationAnalysis
      ? formatInspirationForPrompt(inspirationAnalysis)
      : undefined

    // ── 调用 LLM 生成方案 ──
    const planInput: GeneratePlanInput = {
      topic,
      categoryOptions: CATEGORIES,
      mode,
      creatorIdentityText,
      styleProfileText,
      evidenceText,
      recentWorksText,
      hints: hints.contentType || hints.style ? hints : undefined,
      charactersText: characterBlock.text,
      // 阶段 2：阶段 B 路径下 clarifications 非空，作为硬约束注入 prompt
      clarifications: clarifications.length > 0 ? clarifications : undefined,
      // AI 灵感分析结论（已在 insight 态由用户确认）
      inspirationContextText,
    }

    const plan = await generatePlan(planInput)
    if (!plan) {
      return NextResponse.json(
        { error: '创作方案生成失败，请稍后重试或改用手动设置' },
        { status: 502 }
      )
    }

    // WF1 推荐采纳回流：带 rec_id 且方案生成成功 = 采纳。
    // await 而非 fire-and-forget：serverless 下后台任务可能被冻结，两次轻量
    // DB 写的成本可忽略；函数内部永不抛错，不影响下方响应。
    if (auth && typeof body.rec_id === 'string' && body.rec_id.trim()) {
      await adoptRecommendation(auth.supabase, auth.userId, body.rec_id.trim(), topic)
    }

    return NextResponse.json({ plan })
  } catch (error) {
    console.error('creative plan API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
