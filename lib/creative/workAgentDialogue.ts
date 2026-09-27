// ============================================================
// Work Agent Dialogue（讨论 / 陪伴模式回应生成器）—— 仅服务端
//
// 存在意义：用户说"我感觉写出来没人看"时，要的不是一张修改方案表单。
//   这一层给的是：我的理解 → 可能的原因 → 建议方向 → 一个待确认的问题。
//   它**不产出候选按钮**：用户还没决定要改，给按钮等于替他做了决定。
//
// 与 IntentClarifier 的分工（不要混用）：
//   clarifyIntent  → 用户已决定要改，只是说不清改哪里（产出候选供点选）
//   composeDialogue→ 用户还没决定要改，或正在受挫（产出分析 + 提问）
//
// 两条硬规则（写死在 prompt 里，这是本模块唯一的产品底线）：
//   1. **禁止虚假鼓励。** 上下文里没有正向证据就不许说"写得很好""很有潜力"——
//      空洞的夸奖会让用户失去判断力，而判断力正是我们要帮他建立的东西
//   2. **原因必须来自上下文。** 诊断、目标读者、历史修改轨迹、创作者画像里
//      没有的东西一律不许推断成"问题"
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { callDeepSeekChat, llmTimeoutMs } from '@/lib/llm'
import { languageDirective, resolveTargetLanguage, type LanguageCode } from '@/lib/languageConsistency'
import { formatContextForPrompt } from './workAgentContext'
import {
  normalizeAgentDialogue,
  type AgentDialogue,
  type WorkAgentContext,
} from './workAgent'

export interface ComposeDialogueInput {
  /** 讨论 = 用户在征询判断；陪伴 = 用户正在受挫或迷茫 */
  mode: 'discuss' | 'companion'
  /** 用户本轮原话 */
  freeText: string
  /** 统一装配的上下文（与三个阶段同一份） */
  context: WorkAgentContext
  /** 目标输出语言；不传时从用户发言推断 */
  language?: LanguageCode
}

export interface ComposeDialogueResult {
  dialogue: AgentDialogue
  /** 拼好的展示文案（落 work_agent_messages.content，刷新后可直接渲染） */
  content: string
}

const DIALOGUE_JSON_KEYS = 'understanding, causes[], directions[], question'

const COMPANION_EXTRA = [
  '',
  '陪伴模式的额外要求（硬性）：',
  '- 第一句必须先接住他的处境，承认这个处境是常见的、不是他一个人的问题；',
  '- 紧接着必须给出**基于上下文的具体分析**，不许停在"加油""你很棒"——',
  '  没有正向证据就绝对不要夸，把力气用在"问题可能出在哪"上；',
  '- 结尾给出一条他现在就能做的最小动作（比如"先只改开头第一句"），',
  '  大目标是压力，小动作才是出路；',
  '- 不催促他改稿：改不改由他决定，你只负责让他看清现在站在哪。',
].join('\n')

const DISCUSS_EXTRA = [
  '',
  '讨论模式的额外要求（硬性）：',
  '- 用户是在问你的判断，不是在派活，不要急着给修改方案；',
  '- causes 要分清"从诊断看出来的"与"你的推断"，推断的必须写明是推断；',
  '- directions 给方向而不是给结论——他想清楚要什么之后自然会开始改。',
].join('\n')

function buildSystemPrompt(lang: LanguageCode, mode: 'discuss' | 'companion'): string {
  return [
    '你是一位资深内容编辑，也是这位创作者的长期合作伙伴。',
    '你们正在讨论一篇已经写好的作品。此刻不要动手改文章。',
    '',
    '输出四段内容：',
    '- understanding：一句话复述你对他此刻处境的理解（不是复述他的原话）；',
    '- causes：2-4 条"可能的原因"，每条必须是上下文里真实存在的证据或标注清楚的推断；',
    '- directions：2-3 条可执行的方向（不是方案细节，是"可以往哪走"）；',
    '- question：一个待他确认的开放问题，用来厘清真正该往哪走；',
    '',
    '硬性约束：',
    '- 禁止虚假鼓励：上下文没有支撑的正向评价一律不许出现；',
    '- 禁止编造事实：诊断没说的缺陷、素材里没有的案例、作品里没有的优点，一律不许出现；',
    '- 不许输出修改方案（不要列"改开头/加案例"这类待选按钮），本轮只做分析与提问；',
    '- understanding ≤ 80 字，每条 cause ≤ 60 字，每条 direction ≤ 40 字，question ≤ 60 字。',
    mode === 'companion' ? COMPANION_EXTRA : DISCUSS_EXTRA,
    '',
    '硬性输出要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    languageDirective(lang),
    `3. JSON 必须严格包含以下 key：${DIALOGUE_JSON_KEYS}`,
  ].join('\n')
}

function buildUserPrompt(input: ComposeDialogueInput): string {
  const lines: string[] = [formatContextForPrompt(input.context), '', '───────────']
  lines.push(`用户说的话：${input.freeText}`)
  lines.push(
    '───────────',
    '',
    input.mode === 'companion'
      ? '用户此刻更像是在表达创作上的困顿。请按陪伴模式回应。'
      : '用户在征询你的判断。请按讨论模式回应。'
  )
  return lines.join('\n')
}

/** 把结构化回应拼成消息正文（落库后用，保证刷新页面后不丢结构） */
export function formatDialogueForDisplay(d: AgentDialogue, mode: 'discuss' | 'companion'): string {
  const lines: string[] = [d.understanding]
  if (d.causes.length > 0) {
    lines.push('', '可能的原因：')
    d.causes.forEach((c, i) => lines.push(`${i + 1}. ${c}`))
  }
  if (d.directions.length > 0) {
    lines.push('', '可以考虑的方向：')
    d.directions.forEach((c, i) => lines.push(`${i + 1}. ${c}`))
  }
  lines.push('', d.question)
  if (mode === 'companion') {
    lines.push('', '想改的时候直接告诉我想先动哪里，我们再一步步来。')
  }
  return lines.join('\n')
}

// ── LLM 调用 ──────────────────────────────────────────────

/**
 * 生成讨论/陪伴回应。失败返回 null（调用方降级回"澄清 → 方案 → 补丁"流水线）。
 *
 * 温度：陪伴 0.7（要有温度，不能是模板腔）/ 讨论 0.4（要准）。
 * max_tokens 900：四段短文本，远小于方案生成。
 */
export async function composeAgentDialogue(
  input: ComposeDialogueInput,
  /**
   * Phase 4 计费上下文：传了才计费，不传则行为与既有调用点一致。
   */
  billing?: { supabase: SupabaseClient; userId: string; refId?: string }
): Promise<ComposeDialogueResult | null> {
  const freeText = input.freeText.trim()
  if (freeText.length < 2) return null

  // 对话式回应跟随用户此刻的发言语言（与 intentClarifier 同口径）
  const target =
    input.language ??
    resolveTargetLanguage([
      { text: freeText, weight: 100, label: 'feedback' },
      { text: input.context.work.content, weight: 20, label: 'article' },
    ]).language

  const maxTokens = 900
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callDeepSeekChat({
      messages: [
        { role: 'system', content: buildSystemPrompt(target, input.mode) },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      temperature: input.mode === 'companion' ? 0.7 : 0.4,
      max_tokens: maxTokens,
      jsonMode: true,
      timeoutMs: llmTimeoutMs(maxTokens, 60),
      language: target,
      languageRetry: attempt === 0,
      ...(billing
        ? {
            billing: {
              supabase: billing.supabase,
              userId: billing.userId,
              ability: 'chat' as const,
              refId: `${billing.refId ?? crypto.randomUUID()}:dialogue:${attempt}`,
              description: input.mode === 'companion' ? '创作陪伴' : '创作讨论',
            },
          }
        : {}),
    })
    if (!res.ok) continue
    try {
      const dialogue = normalizeAgentDialogue(JSON.parse(res.content))
      if (dialogue) {
        return { dialogue, content: formatDialogueForDisplay(dialogue, input.mode) }
      }
    } catch (e) {
      console.error('讨论/陪伴回应 JSON 解析失败:', e)
    }
  }
  return null
}
