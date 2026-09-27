// ============================================================
// POST /api/creative/work-agent/chat —— Work Agent 三阶段状态机
//
//   say           → 阶段 1：意图澄清（输出 2-4 个候选含义，等用户选）
//   select_intent → 阶段 2：修改方案（输出 2-3 个方案，等用户选）
//   select_plan   → 阶段 3：局部补丁（输出段落补丁，前端让用户决定接受/拒绝）
//
// 为什么状态机放在一个端点而不是三个：
//   三个阶段共享同一份上下文（assembleWorkContext），拆三个端点意味着
//   要么每个请求重算一次上下文，要么在服务端缓存——前者慢，后者脏。
//   单端点可以在一次请求内完成"装配 → 推理 → 落库"，上下文天然新鲜。
//
// 关键设计：
//   1. 每一步都必须用户做决定才推进——AI 不允许跳过任何一个阶段直接改文章
//   2. 任一步 LLM 失败都返回可见的降级提示，不静默跳到下一步
//   3. 历史对话不进 prompt：每个阶段的输出本身已经是"用户确认过的结论"，
//      再塞进 prompt 既烧 token 又会让 AI 反复纠结已经被否掉的方案
// ============================================================

import { NextResponse } from 'next/server'
import { withAiDeadline } from '@/lib/aiDeadline'
import { aiFailureResponse, authFailureResponse } from '@/lib/apiAuth'
import { guardRateLimit } from '@/lib/rateLimit'
import { createServerClient } from '@/lib/supabaseServer'
import { hasEnoughFor } from '@/lib/aiCost'
import { INSUFFICIENT_POINTS_MESSAGE } from '@/lib/balance'
import { assembleWorkContext, formatContextForPrompt } from '@/lib/creative/workAgentContext'
import { clarifyIntent } from '@/lib/creative/intentClarifier'
import { proposeRevisions } from '@/lib/creative/revisionPlan'
import { generateEditPatches, type ModificationPatch } from '@/lib/creative/patchEngine'
import { composeAgentDialogue } from '@/lib/creative/workAgentDialogue'
import { detectInteractionMode } from '@/lib/creative/workAgentMode'
import { assessRevisionRequest } from '@/lib/creative/revisionGuard'
import {
  mapMessageRow,
  type AgentAdvisory,
  type AgentMessageKind,
  type AgentPhase,
  type AgentSessionMeta,
  type FeedbackAnalysis,
  type IntentClarification,
  type IntentOption,
  type RevisionPlan,
  type RevisionProposal,
  type WorkAgentMessage,
} from '@/lib/creative/workAgent'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

type ChatAction = 'say' | 'select_intent' | 'select_plan'

interface ChatBody {
  sessionId?: unknown
  /** 基底版本行 id（generation_history.id）——正文本体以此为准，不信任客户端 */
  generationId?: unknown
  action?: unknown
  /** 用户本轮发言（action='say' 时必填） */
  message?: unknown
  /** 用户在候选中选择的序号 */
  selectedIndex?: unknown
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/**  action → 本轮阶段 kind（user 与 assistant 共用，便于前端按轮次分组渲染） */
const ACTION_KIND: Record<ChatAction, AgentMessageKind> = {
  say: 'intent_clarify',
  select_intent: 'proposal',
  select_plan: 'patch_preview',
}

// 下面的 60 必须等于本文件的 maxDuration。
// 本端点按阶段串行调用多个 LLM 能力（意图澄清 → 修改方案 → 局部补丁），
// 每个内部还有重试，各拿一份预算会远超 maxDuration → 被平台硬杀、预扣退不回。
// 共享一份总预算可避免。见 lib/aiDeadline.ts
async function handlePost(req: Request) {
  try {
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) return NextResponse.json({ error: '请先登录' }, { status: 401 })
    const supabase = createServerClient(token)
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token)
    if (authErr || !user) return authFailureResponse(authErr)

    // 限流（跨实例）：本端点每一轮对话都可能调 LLM，是全站最贵的入口。
    // 放在鉴权之后——限流 key 是 userId，未鉴权时无从限流。
    const limited = await guardRateLimit(user.id, 'work-agent-chat', 20, 60_000)
    if (limited) return limited

    const body = (await req.json().catch(() => ({}))) as ChatBody
    const generationId = str(body.generationId, 200)
    const action = (str(body.action, 30) || 'say') as ChatAction
    const message = str(body.message, 2000)
    const selectedRaw = Number(body.selectedIndex)
    const selectedIndex = Number.isInteger(selectedRaw) ? selectedRaw : null

    if (!generationId) return NextResponse.json({ error: '缺少作品版本标识' }, { status: 400 })
    if (action === 'say' && !message) {
      return NextResponse.json({ error: '请输入你的想法' }, { status: 400 })
    }

    // ── 调用前余额预检（Phase 4）─────────────────────────────────
    // 本端点是"多轮对话"，每一轮都可能调 LLM；而链路内部大量使用
    // "失败即降级"（返回 null）的写法——余额不足会让这些能力凭空消失，
    // 用户只会觉得"AI 变笨了"，永远不知道是积分不够。
    // 所以在这里一次性把话说明白，比让每一轮静默降级要诚实。
    const budget = await hasEnoughFor(supabase, user.id, 'chat')
    if (!budget.ok) {
      return NextResponse.json(
        { error: INSUFFICIENT_POINTS_MESSAGE, code: 'insufficient_balance' },
        { status: 402 }
      )
    }
    if (action !== 'say' && selectedIndex === null) {
      return NextResponse.json({ error: '缺少选择项' }, { status: 400 })
    }

    // ── 基底版本行（归属校验 + 取正文/蓝图/诊断）──
    const { data: row, error: rowErr } = await supabase
      .from('generation_history')
      .select('id, user_id, project_id, version_number, topic, sample_text, blueprint, analysis, created_at')
      .eq('id', generationId)
      .maybeSingle()
    if (rowErr || !row) return NextResponse.json({ error: '作品版本不存在' }, { status: 404 })
    if (row.user_id !== user.id) return NextResponse.json({ error: '无权修改该作品' }, { status: 403 })

    const baseContent = typeof row.sample_text === 'string' ? row.sample_text : ''
    if (!baseContent) return NextResponse.json({ error: '作品内容为空' }, { status: 400 })

    // ── 取/建会话 ──
    let sessionId = str(body.sessionId, 100)
    if (sessionId) {
      const { data: s } = await supabase
        .from('work_agent_sessions')
        .select('*')
        .eq('id', sessionId)
        .eq('user_id', user.id)
        .maybeSingle()
      if (!s) return NextResponse.json({ error: '会话不存在' }, { status: 404 })
    } else {
      const projectId = typeof row.project_id === 'string' ? row.project_id : null
      if (projectId) {
        const { data: s } = await supabase
          .from('work_agent_sessions')
          .select('*')
          .eq('user_id', user.id)
          .eq('project_id', projectId)
          .eq('status', 'active')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (s) sessionId = String((s as Record<string, unknown>).id ?? '')
      }
      if (!sessionId) {
        const { data: created, error: cErr } = await supabase
          .from('work_agent_sessions')
          .insert({
            user_id: user.id,
            project_id: projectId,
            base_version_id: generationId,
            status: 'active',
            phase: 'clarify',
            meta: { turnCount: 0 },
          })
          .select('*')
          .single()
        if (cErr || !created) {
          console.error('chat：会话创建失败:', cErr?.message)
          return NextResponse.json({ error: '会话创建失败' }, { status: 500 })
        }
        sessionId = String((created as Record<string, unknown>).id ?? '')
      }
    }

    // ── 读历史消息（用于取回上一轮 AI 产出的候选集合）──
    const { data: historyRows } = await supabase
      .from('work_agent_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(100)
    const history: WorkAgentMessage[] = (historyRows ?? []).map((r) =>
      mapMessageRow(r as Record<string, unknown>)
    )

    const kind = ACTION_KIND[action]
    const insertMessage = async (p: {
      role: 'user' | 'assistant'
      content: string
      payload?: unknown
      selectedIndex?: number | null
      /** 覆盖默认 kind（讨论/陪伴回应、守门提示走这里） */
      kind?: AgentMessageKind
    }) => {
      const { data: m, error: e } = await supabase
        .from('work_agent_messages')
        .insert({
          session_id: sessionId,
          user_id: user.id,
          role: p.role,
          kind: p.kind ?? kind,
          content: p.content.slice(0, 4000),
          payload: p.payload ?? null,
          selected_index: p.selectedIndex ?? null,
        })
        .select('*')
        .single()
      if (e) {
        console.error('chat：消息写入失败:', e.message)
        return null
      }
      return mapMessageRow(m as Record<string, unknown>)
    }

    /**
     * 推进会话阶段。meta 为增量合并（不能整块覆盖，否则会丢掉上一阶段记下的指针，
     * 比如已选的意图序号——那正是"用户到底选了什么"的唯一证据）。
     */
    const setPhase = async (phase: AgentPhase, metaPatch: AgentSessionMeta = {}) => {
      const { data: cur } = await supabase
        .from('work_agent_sessions')
        .select('meta')
        .eq('id', sessionId)
        .maybeSingle()
      const prev: AgentSessionMeta =
        cur && typeof cur.meta === 'object' && cur.meta !== null
          ? (cur.meta as AgentSessionMeta)
          : {}
      const { error } = await supabase
        .from('work_agent_sessions')
        .update({
          phase,
          meta: { ...prev, ...metaPatch },
          updated_at: new Date().toISOString(),
        })
        .eq('id', sessionId)
        .eq('user_id', user.id)
      if (error) console.error('chat：阶段更新失败:', error.message)
    }

    // ══════════ 阶段 1：意图澄清 ══════════
    if (action === 'say') {
      await insertMessage({ role: 'user', content: message })

      const context = await assembleWorkContext({
        client: supabase,
        userId: user.id,
        projectId: typeof row.project_id === 'string' ? row.project_id : null,
        versionRow: {
          id: row.id as string,
          topic: typeof row.topic === 'string' ? row.topic : null,
          sample_text: baseContent,
          blueprint: row.blueprint,
          analysis: row.analysis,
          created_at: typeof row.created_at === 'string' ? row.created_at : null,
          version_number: Number(row.version_number ?? 0) || 0,
        },
        intentHint: message.slice(0, 60),
      })

      // ── 模式路由 + 修改守门 ──
      // 两者都是确定性规则（零 LLM）：判定发生在每一轮对话的第一步，
      // 多一次模型调用就是多几秒等待，而这两件事本就是可枚举的规则问题。
      const mode = detectInteractionMode(message)
      const advisory: AgentAdvisory | null = assessRevisionRequest(message)

      // 直接修改模式：用户明示"别问了直接改"，再给他一轮候选就是违背指令。
      // 复用既有的 skipToPlan 降级通道（前端会自动连推到补丁预览），
      // 最终仍然要经过用户点"接受"才落新版本——跳过的是讨论，不是确认权。
      if (mode.mode === 'direct') {
        const notice = await insertMessage({
          role: 'assistant',
          kind: 'system_notice',
          content: '好，跳过讨论，我直接按你的意思改。改完仍需你确认才会生成新版本。',
          payload: advisory ? { advisory } : null,
        })
        await setPhase('clarify', { lastMode: mode.mode })
        return NextResponse.json({
          ok: true,
          degraded: false,
          phase: 'clarify',
          sessionId,
          message: notice,
          mode: mode.mode,
          advisory,
          skipToPlan: true,
          degradedReasons: context.degraded,
        })
      }

      // 讨论 / 陪伴模式：用户还没决定要改（或正在受挫），先给分析与提问。
      // 注意这一步**不产出候选按钮**——给按钮等于替他做了"开始改"这个决定。
      if (mode.mode === 'discuss' || mode.mode === 'companion') {
        const reply = await composeAgentDialogue(
          { mode: mode.mode, freeText: message, context },
          { supabase, userId: user.id, refId: `${sessionId}:dialogue` }
        )
        if (reply) {
          const assistant = await insertMessage({
            role: 'assistant',
            kind: 'dialogue',
            content: reply.content,
            payload: { ...reply.dialogue, advisory },
          })
          await setPhase('clarify', { lastMode: mode.mode })
          return NextResponse.json({
            ok: true,
            degraded: false,
            phase: 'clarify',
            sessionId,
            message: assistant,
            mode: mode.mode,
            advisory,
            degradedReasons: context.degraded,
          })
        }
        // 降级：陪伴/讨论没能生成回应时绝不报错卡住，继续走正常澄清流水线。
        // 用户看到的最坏结果是"像以前一样给候选"，比"AI 没反应"好得多。
        console.error('chat：讨论/陪伴回应生成失败，降级为意图澄清')
      }

      const clarification = await clarifyIntent(
        { freeText: message, context },
        // 计费上下文：refId 带上会话与阶段，流水里能对上是哪一轮花的
        { supabase, userId: user.id, refId: `${sessionId}:clarify` }
      )

      if (!clarification) {
        // 降级：不假装"理解了"，直接告诉用户我们没能拆出候选，并把原话当作 custom 指令
        const notice = await insertMessage({
          role: 'assistant',
          content:
            '我没能把这句反馈拆成明确的候选方向，将直接按你的原话来处理。你可以再补充一句更具体的描述（比如"开头不够吸引人"），我会给出方案。',
          payload: advisory ? { degraded: true, advisory } : { degraded: true },
        })
        await setPhase('clarify', { turnCount: (history.length + 2) / 2, lastError: 'clarify_failed' })
        return NextResponse.json({
          ok: true,
          degraded: true,
          phase: 'clarify',
          sessionId,
          message: notice,
          mode: mode.mode,
          advisory,
          skipToPlan: true, // 前端据此直接拿方案，不必卡在候选选择
        })
      }

      const issues = clarification.observedIssues.length
        ? `\n\n我看这篇目前的问题：\n${clarification.observedIssues.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
        : ''
      const assistant = await insertMessage({
        role: 'assistant',
        content: `${clarification.understanding}${issues}\n\n你希望优先往哪个方向改？`,
        payload: advisory ? { ...clarification, advisory } : clarification,
      })
      await setPhase('clarify', { turnCount: Math.floor((history.length + 2) / 2), lastMode: mode.mode })
      return NextResponse.json({
        ok: true,
        degraded: false,
        phase: 'clarify',
        sessionId,
        message: assistant,
        mode: mode.mode,
        advisory,
        degradedReasons: context.degraded,
      })
    }

    // ══════════ 阶段 2：修改方案 ══════════
    if (action === 'select_intent') {
      const last = [...history].reverse().find((m) => m.kind === 'intent_clarify' && m.role === 'assistant')
      const clarification = last?.payload as IntentClarification | null
      const options = clarification?.options ?? []
      const picked: IntentOption | null = options[selectedIndex ?? -1] ?? null

      // 用户本轮最初的反馈原话（澄清阶段那条 user 消息），作为方案的诉求来源
      const userSay = [...history].reverse().find((m) => m.role === 'user' && m.kind === 'intent_clarify')
      const freeText = userSay?.content || picked?.description || ''
      if (!freeText) {
        return NextResponse.json({ error: '未找到你的反馈原话，请重新描述' }, { status: 400 })
      }
      // 降级链路：上一步没能拆出候选时前端会以 selectedIndex=-1 自动推进。
      // 这里绝不能 400——否则用户看到"我没能拆成候选"后既无候选可点、
      // 也进不了下一步，只能反复重发同一句反馈，界面等同卡死。
      // 缺失候选时用用户原话构造一个 custom 意图，把流程继续走完。
      const intent: IntentOption = picked ?? {
        id: 'raw-feedback',
        label: '你的原话',
        description: freeText.slice(0, 60),
        intentType: 'custom',
      }

      await insertMessage({
        role: 'user',
        content: `已确认方向：${intent.label}`,
        payload: intent,
        selectedIndex,
      })

      const context = await assembleWorkContext({
        client: supabase,
        userId: user.id,
        projectId: typeof row.project_id === 'string' ? row.project_id : null,
        versionRow: {
          id: row.id as string,
          topic: typeof row.topic === 'string' ? row.topic : null,
          sample_text: baseContent,
          blueprint: row.blueprint,
          analysis: row.analysis,
          created_at: typeof row.created_at === 'string' ? row.created_at : null,
          version_number: Number(row.version_number ?? 0) || 0,
        },
        intentHint: intent.label,
      })

      const proposal = await proposeRevisions(
        { freeText, intent, context },
        { supabase, userId: user.id, refId: `${sessionId}:propose` }
      )

      if (!proposal) {
        const notice = await insertMessage({
          role: 'assistant',
          content: '我没能给出多个可选方案，将按这个方向直接生成修改建议。',
          payload: { degraded: true, intent: picked },
        })
        await setPhase('propose', { chosenIntentIndex: selectedIndex, lastError: 'propose_failed' })
        return NextResponse.json({
          ok: true,
          degraded: true,
          phase: 'propose',
          sessionId,
          message: notice,
          intent,
          skipPlan: true,
        })
      }

      const assistant = await insertMessage({
        role: 'assistant',
        content: `${proposal.summary}\n\n请选择一种改法：`,
        payload: proposal,
      })
      await setPhase('propose', { chosenIntentIndex: selectedIndex })
      return NextResponse.json({
        ok: true,
        degraded: false,
        phase: 'propose',
        sessionId,
        message: assistant,
        intent,
        degradedReasons: context.degraded,
      })
    }

    // ══════════ 阶段 3：局部补丁 ══════════
    const lastProposalMsg = [...history]
      .reverse()
      .find((m) => m.kind === 'proposal' && m.role === 'assistant')
    const proposal = lastProposalMsg?.payload as RevisionProposal | null
    const pickedPlan: RevisionPlan | null = proposal?.plans?.[selectedIndex ?? -1] ?? null

    // 用户在阶段 2 选中的意图：读当时那条 user 消息的 payload，
    // 而不是从 options 数组里按序号反推——反推会在候选重建时错位，也会把
    // "用户当时选了什么"变成依赖当前数据的猜测。
    const intentPickMsg = [...history]
      .reverse()
      .find((m) => m.kind === 'proposal' && m.role === 'user')
    const pickedIntent: IntentOption | null = (intentPickMsg?.payload as IntentOption | null) ?? null

    const userSay = [...history].reverse().find((m) => m.role === 'user' && m.kind === 'intent_clarify')
    const freeText = userSay?.content || pickedPlan?.description || ''
    if (!freeText) {
      return NextResponse.json({ error: '未找到你的反馈原话，请重新描述' }, { status: 400 })
    }
    // 降级链路：上一步没能给出多个方案时前端以 selectedIndex=-1 自动推进。
    // 不能 400——否则用户停留在"我没能给出多个方案"这句提示上，既没有方案可选
    // 也拿不到补丁，这一次共创就彻底断了。缺失方案时用原话构造一个保底方案。
    const plan: RevisionPlan = pickedPlan ?? {
      id: 'raw-plan',
      title: '按你的原话修改',
      description: freeText.slice(0, 200),
      expectedImpact: '直接落实你提出的反馈',
      modificationArea: [],
      preserveItems: ['核心观点与整体结构'],
      risk: '',
      strategy: 'patch',
    }

    await insertMessage({
      role: 'user',
      content: `已选方案：${plan.title}`,
      payload: plan,
      selectedIndex,
    })

    // rewrite 策略：不能走局部补丁，否则等于违背"只在承诺范围内改"的契约，
    // 回前端走已有的全文重写链路（用户仍会看到是一次明确的重写，而非偷偷重来）
    if (plan.strategy === 'rewrite') {
      const assistant = await insertMessage({
        role: 'assistant',
        content: `这个方案需要重写全文：${plan.risk || '会改变整体结构'}。已切换为全文优化，将为你生成新版本。`,
        payload: { rewrite: true, plan },
      })
      await setPhase('apply', { chosenPlanIndex: selectedIndex })
      return NextResponse.json({
        ok: true,
        rewrite: true,
        phase: 'apply',
        sessionId,
        message: assistant,
        plan,
        instruction: `${freeText}｜改法：${plan.description}`,
      })
    }

    const context = await assembleWorkContext({
      client: supabase,
      userId: user.id,
      projectId: typeof row.project_id === 'string' ? row.project_id : null,
      versionRow: {
        id: row.id as string,
        topic: typeof row.topic === 'string' ? row.topic : null,
        sample_text: baseContent,
        blueprint: row.blueprint,
        analysis: row.analysis,
        created_at: typeof row.created_at === 'string' ? row.created_at : null,
        version_number: Number(row.version_number ?? 0) || 0,
      },
      intentHint: plan.title,
    })

    // 把"用户已确认的意图 + 方案"合成 patchEngine 能吃的 FeedbackAnalysis，
    // 省掉一次 feedbackAnalyzer 的 LLM 调用，且结论更贴合用户刚做的选择
    const analysis: FeedbackAnalysis = {
      intentType: pickedIntent?.intentType ?? 'custom',
      modificationTargets: [plan.title, ...plan.modificationArea].filter(Boolean).slice(0, 6),
      optimizationBlueprint: plan.description,
      userIntentSummary: freeText.slice(0, 200),
      impactScope: plan.modificationArea,
      preserveItems: plan.preserveItems,
    }

    const result = await generateEditPatches(
      {
        content: baseContent,
        freeText,
        analysis,
        topic: typeof row.topic === 'string' ? row.topic : undefined,
        contextText: formatContextForPrompt(context, { includeContent: false }),
        plan,
      },
      { supabase, userId: user.id, refId: `${sessionId}:patch` }
    )

    if (!result) {
      const assistant = await insertMessage({
        role: 'assistant',
        content: '段落级定位失败，这个改动可能更适合整体重写，请确认是否切换为全文优化。',
        payload: { rewrite: true, plan, degraded: true },
      })
      await setPhase('apply', { chosenPlanIndex: selectedIndex, lastError: 'patch_failed' })
      return NextResponse.json({
        ok: true,
        degraded: true,
        rewrite: true,
        phase: 'apply',
        sessionId,
        message: assistant,
        plan,
        instruction: `${freeText}｜改法：${plan.description}`,
      })
    }

    const patches: ModificationPatch[] = result.patches
    const assistant = await insertMessage({
      role: 'assistant',
      content: `${result.summary}\n\n即将修改 ${patches.length} 处，保持：${plan.preserveItems.join('、')}。`,
      payload: { plan, patches, preview: { targetSegments: patches.map((p) => p.segmentIndex) } },
    })
    await setPhase('apply', { chosenPlanIndex: selectedIndex })
    return NextResponse.json({
      ok: true,
      degraded: false,
      phase: 'apply',
      sessionId,
      message: assistant,
      plan,
      patches,
      summary: result.summary,
      analysis, // 回传，供 decide 落版时写 improve_direction / 记忆事件
      degradedReasons: context.degraded,
    })
  } catch (e) {
    console.error('work-agent chat 异常:', e)
    return await aiFailureResponse('对话处理失败，请重试')
  }
}

export const POST = withAiDeadline(60, handlePost)
