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
} from './diagnosisMeta'

// ── 诊断的类型、展示元数据与归一化函数 ──
// 这些是纯常量 / 纯函数，已抽到 ./diagnosisMeta（零运行时依赖），
// 目的是让 'use client' 组件引用它们时不会连带打进服务端模块
// （本文件含 DeepSeek 调用与 process.env 读取，绝不能进浏览器 bundle）。
// 此处再导出以保持既有调用方不变。
export {
  DIMENSION_META,
  DIAGNOSIS_LENS_META,
  LEVEL_LABELS,
  NEXT_ACTION_META,
  normalizeDiagnosis,
  parseDiagnosis,
} from './diagnosisMeta'
export type {
  DimensionKey,
  NextActionKey,
  DiagnosisDimension,
  DiagnosisLensKey,
  DiagnosisLens,
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

/** 诊断结果：失败时带错误码，供上层翻译成准确文案（如「AI 服务额度不足」） */
export type DiagnosisLlmResult =
  | { ok: true; data: Omit<CreativeDiagnosis, 'diagnosedAt'> }
  | { ok: false; error: string }

/**
 * 调用 DeepSeek 对成稿做五维诊断（强制 JSON 输出）。
 * 仅服务端使用；失败返回 { ok:false, error }（早期返回裸 null，调用方只能给出
 * 「诊断失败，请稍后重试」，余额耗尽这类只有人能修的原因被完全吞掉）。
 */
export async function generateDiagnosis(
  input: DiagnosisInput
): Promise<DiagnosisLlmResult> {
  // 诊断的是 input.sampleText 这篇稿件 → 以它的语言为准；topic 仅作次要依据
  const target =
    input.language ??
    resolveTargetLanguage([
      { text: input.sampleText, weight: 100, label: 'sampleText' },
      { text: input.topic, weight: 40, label: 'topic' },
      { text: input.style, weight: 10, label: 'style' },
    ]).language

  // 输出刻意只保留用户真正会读的两段（表现良好 / 需要改进）：
  // 五维点评、问题与建议分列、六类下一步方向已全部移除——它们与被保留的两段
  // 内容高度重复，却占掉诊断输出绝大部分 token。
  const system = [
    '你是资深短视频内容总编，每年审稿数千条，诊断以犀利、具体、可执行著称，从不给客套话。',
    '任务：对给定的解说成稿做一次体检，只输出"表现良好"和"需要改进"两部分。',
    '硬性要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    // 诊断对象（成稿）决定诊断语言：点评一篇英文稿却给中文结论，读者无法对照使用
    languageDirective(target),
    '3. JSON 含两个必填 key：strengths（表现良好）与 improvements（需要改进），各 2-3 条；',
    '4. 每条必须引用/对应稿件中的具体写法，禁止"引人入胜""节奏不错"这类空话；',
    '5. improvements 每条写成"问题 → 怎么改"的一句话，改法要具体到能直接照做；',
    '6. 每条不超过 40 字；',
    '7. 另附可选 key：lenses —— 从「观点 / 证据 / 表达」三个镜头各给一条 good（做得好）与 fix（怎么改），',
    '   格式为 {"viewpoint":{"good":"","fix":""},"evidence":{...},"expression":{...}}，每个值不超过 40 字；',
    '   观点=主张是否立得住，证据=论据是否具体可验证，表达=语言与节奏是否到位。禁止输出其他字段。',
  ].join('\n')

  const user = `请诊断以下成稿：

解说主题：${input.topic}
创作者身份：${input.identityLabel || '未记录'}
文风要求：${input.style || '由身份自然决定'}
内容品类：${input.category || '未指定'}
${input.blueprint ? `${formatBlueprintForPrompt(input.blueprint)}\n` : ''}
【待诊断成稿】
${input.sampleText.slice(0, 6000)}

从开头吸引力、结构递进、情感共鸣、风格贴合、传播潜力五个方面权衡取舍，
输出 strengths（表现良好，保持即可）与 improvements（需要改进：问题 → 怎么改）两部分，各 2-3 条；
再附 lenses：从观点、证据、表达三个镜头各给一条 good 与一条 fix。`

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
        // 两段短句 + 三镜头各两条，上限适度放宽（原 600）
        max_tokens: 900,
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // 402 = 余额耗尽（Insufficient Balance）。这类必须单独识别：
      // 它与网络抖动、超时不同，重试一万次也不会好，只有充值才能解决。
      console.error(`作品诊断失败: HTTP ${res.status}`, body.slice(0, 200))
      return { ok: false, error: `http_${res.status}` }
    }
    const data = await res.json()
    const text: string = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'empty_content' }
    }

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const parsed: unknown = JSON.parse(cleaned)
    const normalized = normalizeDiagnosis(parsed)
    if (!normalized) return { ok: false, error: 'parse_failed' }
    return { ok: true, data: normalized }
  } catch (e) {
    const isAbort = e instanceof Error && e.name === 'AbortError'
    const code = isAbort
      ? 'timeout'
      : e instanceof Error && /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(e.message)
        ? 'network_error'
        : 'parse_failed'
    console.error('作品诊断异常:', e)
    return { ok: false, error: code }
  }
}

/** 从任意来源（DB jsonb）安全解析一份带时间戳的完整诊断 */
/** 供 API 层把库内蓝图 jsonb 安全转成诊断输入 */
export function blueprintFromRaw(raw: unknown): CreativeBlueprint | null {
  return normalizeBlueprint(raw)
}
