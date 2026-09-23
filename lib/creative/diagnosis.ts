// ============================================================
// AI 作品诊断（Creative Diagnosis）—— 前后端共享
// 阶段 4：每次生成后自动从 5 个维度评估作品，输出优势 / 问题 /
//         可执行建议，并给出 6 类"下一步创作方向"。
// 评分刻意使用 1-5 的定性信号等级（突出/良好/中规中矩/偏弱/待提升），
// 不使用精确百分制，避免伪精确与"唯分数"误导。
// 纯类型 + 纯函数 + 服务端 LLM 调用，前端只 import 类型与元数据。
// ============================================================

import { formatBlueprintForPrompt, normalizeBlueprint, type CreativeBlueprint } from './blueprint'
import { llmTimeoutSignal } from '@/lib/llm'
import { languageDirective, resolveTargetLanguage, type LanguageCode } from '@/lib/languageConsistency'

import {
  normalizeDiagnosis,
  type CreativeDiagnosis,
  type DimensionKey,
  type NextActionKey,
} from './diagnosisMeta'

// ── 诊断的类型、展示元数据与归一化函数 ──
// 这些是纯常量 / 纯函数，已抽到 ./diagnosisMeta（零运行时依赖），
// 目的是让 'use client' 组件引用它们时不会连带打进服务端模块
// （本文件含 DeepSeek 调用与 process.env 读取，绝不能进浏览器 bundle）。
// 此处再导出以保持既有调用方不变。
export {
  DIMENSION_META,
  LEVEL_LABELS,
  NEXT_ACTION_META,
  normalizeDiagnosis,
  parseDiagnosis,
} from './diagnosisMeta'
export type {
  DimensionKey,
  NextActionKey,
  DiagnosisDimension,
  CreativeDiagnosis,
} from './diagnosisMeta'

export interface DiagnosisInput {
  topic: string
  identityLabel: string
  style: string
  category: string
  blueprint?: CreativeBlueprint | null
  sampleText: string
  /** 目标输出语言；不传时以成稿语言为准 */
  language?: LanguageCode
}

/**
 * 调用 DeepSeek 对成稿做五维诊断（强制 JSON 输出）。
 * 仅服务端使用；失败返回 null，调用方决定降级（前端静默/允许重试）。
 */
export async function generateDiagnosis(
  input: DiagnosisInput
): Promise<Omit<CreativeDiagnosis, 'diagnosedAt'> | null> {
  // 诊断的是 input.sampleText 这篇稿件 → 以它的语言为准；topic 仅作次要依据
  const target =
    input.language ??
    resolveTargetLanguage([
      { text: input.sampleText, weight: 100, label: 'sampleText' },
      { text: input.topic, weight: 40, label: 'topic' },
      { text: input.style, weight: 10, label: 'style' },
    ]).language

  const system = [
    '你是资深短视频内容总编，每年审稿数千条，诊断以犀利、具体、可执行著称，从不给客套话。',
    '任务：对给定的解说成稿做一次完整体检，输出结构化 JSON 诊断报告。',
    '硬性要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    // 诊断对象（成稿）决定诊断语言：点评一篇英文稿却给中文结论，读者无法对照使用
    languageDirective(target),
    '3. 点评必须引用/对应稿件中的具体写法，禁止"引人入胜""节奏不错"这类空话；',
    '3. level 为严格的 1-5 整数：5=突出 4=良好 3=中规中矩 2=偏弱 1=待提升。评分要真实、敢给低分，五个维度允许相同；',
    '4. 不要输出百分制分数；',
    '5. JSON 必须严格包含以下 key：',
    'dimensions{opening{level,comment}, structure{level,comment}, emotion{level,comment}, style_fit{level,comment}, virality{level,comment}},',
    'strengths[string], problems[string], suggestions[string],',
    'next_actions{hit,style,emotion,depth,video,script}（每个值一句话，说明"选择该方向后下一步具体怎么改"，必须与本篇稿件的实际问题挂钩）。',
  ].join('\n')

  const user = `请诊断以下成稿：

解说主题：${input.topic}
创作者身份：${input.identityLabel || '未记录'}
文风要求：${input.style || '由身份自然决定'}
内容品类：${input.category || '未指定'}
${input.blueprint ? `${formatBlueprintForPrompt(input.blueprint)}\n` : ''}
【待诊断成稿】
${input.sampleText.slice(0, 6000)}

请逐维度点评：
- opening：开头 3 秒 Hook 是否具体、有悬念/反差，第一句话值不值得停下来；
- structure：段落递进、信息密度、是否有冗余或断裂；
- emotion：情绪曲线是否成立、共鸣点是否落地；
- style_fit：叙述人格、句式、节奏与上方身份/文风要求的贴合程度；
- virality：记忆点、互动引导、被转发的理由（不要给百分比，只给等级和理由）。
strengths/problems/suggestions 各给 2-4 条，问题与建议要一一可落地。`

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: llmTimeoutSignal(1600),
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 1600,
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      console.error('作品诊断失败:', await res.text())
      return null
    }
    const data = await res.json()
    const text: string = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) return null

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const parsed: unknown = JSON.parse(cleaned)
    return normalizeDiagnosis(parsed)
  } catch (e) {
    console.error('作品诊断异常:', e)
    return null
  }
}

/** 从任意来源（DB jsonb）安全解析一份带时间戳的完整诊断 */
/** 供 API 层把库内蓝图 jsonb 安全转成诊断输入 */
export function blueprintFromRaw(raw: unknown): CreativeBlueprint | null {
  return normalizeBlueprint(raw)
}
