// ============================================================
// Intent Clarifier（意图澄清器）—— Work Agent 阶段 1
//
// 职责：把用户一句模糊反馈（"感觉太平了""太像 AI 写的"）翻译成
//       2-4 种可能的含义，让用户选择，而不是让 AI 猜测后直接改。
//
// 为什么单独一层（而不是顺手扩大 analyzeFeedback）：
//   analyzeFeedback 产出的 FeedbackAnalysis 是「单一结论」，用于历史 prompt 注入；
//   本文件系统性地输出「候选集合 + 依据」，用于人机确认。
//   二者语义不同：前者是执行指令，后者是对话素材。混用会让 AI 误以为我们已经确认了。
//
// 关键约束：
//   1. 每个候选必须给出 evidence（依据来自诊断/画像/素材中的哪一条）——禁止无依据的猜谜
//   2. 候选之间必须实质不同（"缺冲突"和"没意思"不能并列）
//   3. 失败返回 null，调用方降级为「直接把用户原话当 custom 意图」
// ============================================================

import { callDeepSeekChat, llmTimeoutMs } from '@/lib/llm'
import { languageDirective, resolveTargetLanguage, type LanguageCode } from '@/lib/languageConsistency'
import {
  normalizeIntentClarification,
  type IntentClarification,
  type WorkAgentContext,
} from './workAgent'
import { formatContextForPrompt } from './workAgentContext'

export interface ClarifyIntentInput {
  /** 用户本轮自由反馈原文 */
  freeText: string
  /** 统一装配的上下文（三个阶段共用同一份） */
  context: WorkAgentContext
  /** 目标输出语言；不传时从用户反馈推断（对话式回应应跟随用户此刻的发言语言） */
  language?: LanguageCode
}

const CLARIFY_JSON_KEYS =
  'understanding, observed_issues, options[{id,label,description,intent_type,evidence}], recommended_index'

// ── Prompt ────────────────────────────────────────────────
//
// 注意：这里刻意把「上下文」放在用户反馈之前。让 LLM 先读作品与诊断，
// 再看用户那句话——否则它会脱离作品空谈"文章应该怎么写"。

function buildSystemPrompt(lang: LanguageCode): string {
  return [
    '你是一位资深内容编辑，正在和用户一起打磨一篇已经写好的文章。',
    '用户给了一句模糊反馈，你的任务不是马上改文章，而是帮用户弄清楚"我到底想改什么"。',
    '',
    '工作方式：',
    '1. 先基于「AI 作品诊断」「创作者画像」「用户素材」形成对这篇文章的判断；',
    '2. 再看用户的原话，判断它可能对应哪几种不同的修改诉求；',
    '3. 列出 2-4 个候选含义，每个候选必须写出 evidence（你是从哪条上下文依据推断出来的）；',
    '',
    '候选规则（硬性）：',
    '- 候选之间必须实质不同，语义重叠的只保留更具体的那个；',
    '- 不准编造上下文里没有的问题；诊断没提到的缺陷，你可以推断但要标注"推断"而非"诊断指出"；',
    '- label 不超过 12 字，是可直接点选的按钮文案；',
    '- description 一句话讲清这个含义具体改什么，不超过 60 字；',
    '- evidence 一句话引用你的依据来源（如"诊断指出开头吸引力偏弱""画像显示你偏好数据论证"）；',
    '- intent_type 只能从 hit/style/emotion/depth/video/script/custom 中取；',
    '- recommended_index 选你最认可的一个（0-based），不确定就填 null；',
    '',
    '硬性输出要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    // options[].intent_type 会被下游当枚举消费，本地化后无法匹配 → 显式豁免
    languageDirective(lang, { exemptFields: ['intent_type'] }),
    '3. JSON 必须严格包含以下 key：',
    CLARIFY_JSON_KEYS,
    '   understanding 是对用户反馈的整体理解（一句话）；',
    '   observed_issues 是你从上下文发现的这篇作品的真实问题（1-4 条，每条不超过 40 字）。',
  ].join('\n')
}

function buildUserPrompt(input: ClarifyIntentInput): string {
  return [
    formatContextForPrompt(input.context),
    '',
    '───────────',
    `用户的反馈原话：${input.freeText}`,
    '───────────',
    '',
    '请输出该反馈的候选含义。',
  ].join('\n')
}

// ── LLM 调用 ──────────────────────────────────────────────

/**
 * 生成意图候选。失败返回 null（调用方降级为把用户原话直接作为 custom 意图）。
 *
 * 温度 0.4：需要一定发散性才能列出多种可能，但不能偏离用户原意。
 * max_tokens 1200：4 个候选 × (label+description+evidence)，外加 observed_issues。
 * 重试 2 次：结构化输出的偶发 JSON 破损靠重试兜住，重试第 2 次后仍失败才降级。
 */
export async function clarifyIntent(
  input: ClarifyIntentInput
): Promise<IntentClarification | null> {
  const freeText = input.freeText.trim()
  if (freeText.length < 2) return null
  if (freeText.length > 2000) return null

  // 对话式回应跟随用户此刻的发言语言（这是"用户刚刚输入的那句话"）
  const target =
    input.language ??
    resolveTargetLanguage([
      { text: freeText, weight: 100, label: 'feedback' },
      { text: input.context.work.content, weight: 20, label: 'article' },
    ]).language

  const maxTokens = 1200
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callDeepSeekChat({
      messages: [
        { role: 'system', content: buildSystemPrompt(target) },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      temperature: 0.4,
      max_tokens: maxTokens,
      jsonMode: true,
      timeoutMs: llmTimeoutMs(maxTokens),
      language: target,
      // 第 2 次尝试已是兜底重来，不再叠加语言自纠偏以免拖长响应
      languageRetry: attempt === 0,
    })
    if (!res.ok) continue
    try {
      const parsed = normalizeIntentClarification(JSON.parse(res.content))
      if (parsed) return parsed
    } catch (e) {
      console.error('意图澄清 JSON 解析失败:', e)
    }
  }
  return null
}
