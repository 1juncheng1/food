// ============================================================
// Revision Plan（修改方案生成器）—— Work Agent 阶段 2
//
// 职责：在用户确认意图后，给出 2-3 个「可挑选的修改方案」，
//       而不是直接产出补丁。用户先选方案，AI 才动手。
//
// 为什么这一层不能被跳过：
//   "直接给补丁"和"先给方案"的差别，是用户有没有否决权。
//   补丁已经贴到段落上（看起来就该点确认），方案还是一个可比较的想法。
//   这是本次重构把「AI 替用户决定」改为「用户做决定」的关键落点。
//
// 关键约束：
//   1. 默认策略必须是 patch（局部修改）；仅当诉求本质需要重写才允许 rewrite，
//      且必须写明 risk——因为 rewrite 会破坏原结构，用户有权先知道代价
//   2. 每个方案必须写 preserve_items（承诺不动什么）：这是局部修改的信用基础
//   3. modification_area 只能取 6 个段落位枚举，便于前端展示"改哪块"
// ============================================================

import { callDeepSeekChat, llmTimeoutMs } from '@/lib/llm'
import { languageDirective, resolveTargetLanguage, type LanguageCode } from '@/lib/languageConsistency'
import {
  normalizeRevisionProposal,
  type IntentOption,
  type RevisionProposal,
  type WorkAgentContext,
} from './workAgent'
import { formatContextForPrompt } from './workAgentContext'

export interface ProposeRevisionsInput {
  /** 用户本轮反馈原文 */
  freeText: string
  /** 阶段 1 用户选中的意图候选（未走澄清链路时为 null，AI 自行判断方向） */
  intent: IntentOption | null
  context: WorkAgentContext
  /** 目标输出语言；不传时从用户反馈推断 */
  language?: LanguageCode
}

const PLAN_JSON_KEYS =
  'summary, plans[{id,title,description,expected_impact,modification_area[],preserve_items[],risk,strategy}], recommended_index'

function buildSystemPrompt(lang: LanguageCode): string {
  return [
    '你是一位资深内容编辑，和用户一起打磨一篇已经写好的文章。',
    '用户已经确认了修改方向，现在你要给出 2-3 个具体的修改方案供用户挑选。',
    '',
    '方案规则（硬性）：',
    '- 默认 strategy = "patch"（局部修改，只动需要动的段落）；',
    '- 只有当用户的诉求本质上必须重写全文时（如"换个话题重来"），才允许给出 strategy = "rewrite" 的方案，',
    '  且 risk 必须明确写出"将改变整体结构/丢失原有段落"之类的代价；同一批最多 1 个 rewrite 方案；',
    '- title 不超过 12 字（如"重构开头""补一个真实案例"）；',
    '- description 讲清具体怎么做，不超过 100 字；',
    '- expected_impact 讲清改了之后对用户有什么好处（提高前 3 秒吸引力 / 增强可信度…）；',
    '- modification_area 只能从 ["开头","背景","核心内容","高潮","结尾","全篇"] 中取 1-3 个；',
    '- preserve_items 列出该方案承诺"一字不动"的内容（2-4 项，如"核心观点""叙述视角"）；',
    '- 涉及"增加案例/数据"的改动，优先使用「用户个人素材库」里的真实素材，',
    '  素材库没有时才在 description 里说明需要用户补充；禁止编造具体数据；',
    '- 方案之间必须有明显不同的取舍（改的地方不同、力度不同），不要只是措辞差异；',
    '- recommended_index 选你最推荐的一个（0-based），不确定填 null。',
    '',
    '硬性输出要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    // strategy（patch/rewrite）与 modification_area 都是下游枚举匹配的字段，
    // 本地化即失效，必须显式豁免——语言指令不能一刀切覆盖全 JSON
    languageDirective(lang, { exemptFields: ['strategy', 'modification_area'] }),
    '3. JSON 必须严格包含以下 key：',
    PLAN_JSON_KEYS,
    '   summary 是一句话说明"已确认的方向是什么"。',
  ].join('\n')
}

function buildUserPrompt(input: ProposeRevisionsInput): string {
  const lines: string[] = [formatContextForPrompt(input.context), '', '───────────']
  lines.push(`用户的反馈原话：${input.freeText}`)
  if (input.intent) {
    lines.push(
      '',
      '用户已确认的意图：',
      `  含义：${input.intent.label}——${input.intent.description}`,
      `  方向类型：${input.intent.intentType}`,
      input.intent.evidence ? `  依据：${input.intent.evidence}` : ''
    )
  }
  lines.push('───────────', '', '请输出 2-3 个修改方案。')
  return lines.filter(Boolean).join('\n')
}

// ── LLM 调用 ──────────────────────────────────────────────

/**
 * 生成修改方案候选。失败返回 null（调用方降级：跳过方案选择，直接进入补丁生成）。
 *
 * 温度 0.6：方案的"取舍创意"需要比意图澄清更大的发散度。
 * max_tokens 1500：3 个方案 × (title+description+impact+risk+preserve)。
 */
export async function proposeRevisions(
  input: ProposeRevisionsInput
): Promise<RevisionProposal | null> {
  const freeText = input.freeText.trim()
  if (freeText.length < 2) return null

  // 与阶段 1 同口径：对话式产出跟随用户发言语言
  const target =
    input.language ??
    resolveTargetLanguage([
      { text: freeText, weight: 100, label: 'feedback' },
      { text: input.intent?.label, weight: 40, label: 'intent' },
      { text: input.context.work.content, weight: 20, label: 'article' },
    ]).language

  const maxTokens = 1500
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callDeepSeekChat({
      messages: [
        { role: 'system', content: buildSystemPrompt(target) },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      temperature: 0.6,
      max_tokens: maxTokens,
      jsonMode: true,
      timeoutMs: llmTimeoutMs(maxTokens),
      language: target,
      languageRetry: attempt === 0,
    })
    if (!res.ok) continue
    try {
      const parsed = normalizeRevisionProposal(JSON.parse(res.content))
      if (parsed) return parsed
    } catch (e) {
      console.error('修改方案 JSON 解析失败:', e)
    }
  }
  return null
}
