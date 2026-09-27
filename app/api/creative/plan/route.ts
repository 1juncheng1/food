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
import { aiFailureResponse } from '@/lib/apiAuth'
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
import { clampWordCount } from '@/lib/creative/wordCount'
import { resolveMode, buildCreatorIdentity } from '@/lib/creative/personalization'
import { adoptRecommendation } from '@/lib/creative/interest/adopt'
import { buildCreatorContextBlocks } from '@/lib/creative/creatorContext'
import { fetchCreatorStyleProfile } from '@/lib/creative/styleProfileRepo'
import {
  buildKnowledgeInjection,
  summarizeInjectedUnits,
} from '@/lib/creative/knowledgeInject'
import type { CreatorKnowledgeUnit } from '@/lib/creative/knowledgeUnit'
import {
  sanitizeCharacterInput,
  formatCharactersForPrompt,
} from '@/lib/characters'
import type { createServerClient } from '@/lib/supabaseServer'
// 需求 §12：AI 消费必须与积分打通——余额不足禁止调用，充足则原子预扣后调用
import { hasEnoughFor } from '@/lib/aiCost'
import { INSUFFICIENT_POINTS_MESSAGE } from '@/lib/balance'

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
  /**
   * 用户自定义目标字数（生成页可选填写，100-5000）。
   * 传入后方案的三档字数必须包含该值，且 recommended_word_count 等于该值；
   * 冻结方案与正文生成沿用它，实现"我填多少字就写多少字"。
   * 缺省 / 越界 = 不限制，完全由 AI 按主题表达容量给档（行为与改动前一致）。
   */
  word_count?: unknown
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

export async function POST(req: Request) {
  try {
    // ── 强制鉴权：游客不可使用方案生成 ──
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const auth = await authenticateWithToken(token, '请先登录后再生成方案')
    if (!auth.ok) return auth.response

    // ── 限流：10 次/分钟/用户（三方向方案生成是重成本 LLM 路由）──
    const rl = rateLimit(`creative-plan:${auth.userId}`, RATE_LIMIT, RATE_WINDOW_MS)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `操作太频繁，请 ${rl.retryAfterSec} 秒后再试` },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
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
    // Creator Knowledge System Phase 3：本次实际注入方案的知识单元。
    // 灵感模式/游客不会进入下方 creator 分支，因此恒为空 —— 与个人化数据同口径。
    let knowledgeBlock = ''
    let knowledgeUnits: CreatorKnowledgeUnit[] = []
    // Creator Interest Profile：长期关注领域。与知识单元完全同口径 ——
    // 只有「我的模式」才装配，灵感模式恒为空（兴趣画像比知识更私人，不能破例）。
    // 未建模用户 interest_profile 为 {} ，buildInterestBlock 返回空串，零影响。
    let interestBlock = ''

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

      // 个人数据注入统一走装配器（Creator Context）：方案 / 蓝图 / 正文三处同一
      // 口径，杜绝"某一阶段少注入一块"的漂移。声明与修改偏好此前只进正文，
      // 方案阶段看不到用户排斥什么、反复拒绝什么 —— 这里一并补齐。
      const blocks = buildCreatorContextBlocks(profile, {
        stage: 'plan',
        interest: { maxTopics: 5, maxLength: 420 },
      })
      styleProfileText = blocks.styleText
      if (blocks.creatorText) styleProfileText += `\n\n${blocks.creatorText}`
      interestBlock = blocks.interestText

      // Creator Knowledge System Phase 3：方案阶段的知识注入。
      // 只读「已确认 + 置信度达标」的单元 —— AI 侧写的候选到不了这里，
      // 候选→确认必须由用户在 /knowledge 手动完成，这是整条授权链的落点。
      // 读取失败一律降级为空：知识是增强项，不该成为方案生成的必经节点。
      const knowledge = await buildKnowledgeInjection(supabase, userId, topic)
      knowledgeBlock = knowledge.block
      knowledgeUnits = knowledge.units
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
      // 用户自定义字数（可选）：越界/非法一律当作"未指定"，避免脏数据进 prompt
      wordCount: clampWordCount(body.word_count),
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
      // Creator Knowledge System Phase 3：创作者已确认的知识命题
      knowledgeText: knowledgeBlock || undefined,
      // Creator Interest Profile：创作者长期关注领域（我的模式专属，软参考）
      interestText: interestBlock || undefined,
    }

    // ── 调用前余额预检 ────────────────────────────────────────
    // 真正的扣费是 generatePlan 内部的「预扣」那一刀（行锁原子、并发安全）。
    // 这里只是为了让余额不足时返回 402「请充值」，而不是让用户看到
    // 含糊的 502「方案生成失败」后反复重试。
    const budget = await hasEnoughFor(auth.supabase, auth.userId, 'generation')
    if (!budget.ok) {
      return NextResponse.json(
        { error: INSUFFICIENT_POINTS_MESSAGE, code: 'insufficient_balance' },
        { status: 402 }
      )
    }

    const plan = await generatePlan(planInput, {
      supabase: auth.supabase,
      userId: auth.userId,
      refId: crypto.randomUUID(),
    })
    if (!plan) {
      // 失败原因优先取 LLM 真实错误码：余额耗尽要说"额度不足"，而不是让用户空重试
      return await aiFailureResponse('创作方案生成失败，请稍后重试或改用手动设置')
    }

    // WF1 推荐采纳回流：带 rec_id 且方案生成成功 = 采纳。
    // await 而非 fire-and-forget：serverless 下后台任务可能被冻结，两次轻量
    // DB 写的成本可忽略；函数内部永不抛错，不影响下方响应。
    if (auth && typeof body.rec_id === 'string' && body.rec_id.trim()) {
      await adoptRecommendation(auth.supabase, auth.userId, body.rec_id.trim(), topic)
    }

    return NextResponse.json({
      plan,
      // Creator Knowledge System Phase 3：本次方案真正参考了哪些知识。
      // 回传原文而非仅条数 —— 用户才能在方案态核对「AI 有没有真的用上我的观点」。
      usedKnowledgeUnits: summarizeInjectedUnits(knowledgeUnits),
    })
  } catch (error) {
    console.error('creative plan API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
