// ============================================================
// DeepSeek LLM 共享封装（P1-补 优化）
//
// 统一多处直接调用 DeepSeek API 的代码：
//   - 内置 AbortController + timeout 兜底（默认 30s，可覆盖）
//   - 内置 try/catch + 错误日志
//   - 统一响应解析（content 字符串提取）
//   - 统一 Authorization header / endpoint
//   - 统一语言一致性：注入约束 + 输出校验 + 一次自纠偏重试
//
// 失败永不抛错——返回 { ok: false, error }，由调用方降级。
// ============================================================

import {
  checkLanguageConsistency,
  extractUserFacingText,
  languageDirective,
  languageName,
  type ConsistencyCheck,
  type LanguageCode,
} from '@/lib/languageConsistency'

/** DeepSeek chat 消息（OpenAI 兼容格式） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** callDeepSeekChat 调用选项 */
export interface DeepSeekChatOptions {
  messages: ChatMessage[]
  /** 0-2，默认 0.5 */
  temperature?: number
  /** 默认 1500 */
  max_tokens?: number
  /** 强制 JSON 输出，传 true 即设置 response_format: { type: 'json_object' } */
  jsonMode?: boolean
  /** 超时毫秒，默认 30000（30s）。用户触发的 AI 操作可按需调高/调低 */
  timeoutMs?: number
  /** 调用方传入的外部 signal（如 route 已有 AbortController）。与内部 timeout 取先到者 */
  signal?: AbortSignal | null

  // ── 语言一致性（可选，不传则行为与改造前完全一致）──────────
  /**
   * 目标输出语言，应来自用户输入（由 detectLanguage / resolveTargetLanguage 得出）。
   * 传 'unknown' 表示"检测不出"，此时仍会注入"跟随用户输入"的软约束。
   * 不传（undefined）表示调用方自行管理语言，本层不干预——保证向后兼容。
   */
  language?: LanguageCode
  /**
   * 语言不符时是否重试一次，默认 true。
   * 仅当 language 已指定且能被判定（非 unknown）时生效。
   */
  languageRetry?: boolean
  /**
   * JSON 输出里的技术标识符字段（如 slug / cluster_id），语言指令会显式豁免它们，
   * 避免被"请用中文输出"带偏导致下游解析失败。
   */
  languageExemptFields?: string[]
}

/** 统一返回结构：成功带 content，失败带 error */
export type DeepSeekChatResult =
  | { ok: true; content: string; raw: unknown; languageCheck?: ConsistencyCheck }
  | { ok: false; error: string }

const DEFAULT_TIMEOUT_MS = 30_000
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions'

/**
 * 语言重试的最低剩余预算。
 * 低于这个值就不重试：重试是独立的一次完整请求，若剩余时间太少，
 * 只会把已经快完成的任务拖成超时——宁可接受语言瑕疵，也不能让请求失败。
 */
const MIN_RETRY_BUDGET_MS = 15_000

/**
 * 把语言约束追加到最后一条 system 消息。
 *
 * 为什么追加而不是新建一条 role=system：多个 system 消息在 OpenAI 兼容 API 上
 * 的行为并不统一（部分实现只取第一条）。追加到既有 system 尾部最稳。
 * 没有 system 时才在开头补一条。
 */
function withLanguageDirective(
  messages: ChatMessage[],
  lang: LanguageCode,
  opts: { exemptFields?: string[] }
): ChatMessage[] {
  const directive = languageDirective(lang, { exemptFields: opts.exemptFields })

  let lastSystemIdx = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'system') lastSystemIdx = i
  }

  if (lastSystemIdx === -1) {
    return [{ role: 'system', content: directive }, ...messages]
  }

  const copy = [...messages]
  copy[lastSystemIdx] = {
    role: 'system',
    content: `${messages[lastSystemIdx].content}\n\n${directive}`,
  }
  return copy
}

/**
 * 取出参与语言校验的文本。
 * JSON 模式必须先解析再抽字符串值——直接对原始 JSON 做统计会被全英文的 key
 * 淹没，导致纯中文的诊断结果被误判成英文。
 */
function languageSample(content: string, jsonMode?: boolean): string {
  if (!jsonMode) return content
  try {
    return extractUserFacingText(JSON.parse(content))
  } catch {
    return content
  }
}

/** 单次请求（不含语言逻辑），供重试复用 */
async function requestOnce(
  messages: ChatMessage[],
  opts: DeepSeekChatOptions,
  timeoutMs: number
): Promise<DeepSeekChatResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    return { ok: false, error: 'missing_api_key' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // 若调用方传入外部 signal，链接到内部 controller（任一触发即 abort）
  // 注意：外部 signal 不可主动 abort 内部 controller，但内部 timeout 可以
  // 实现：监听外部 signal 的 abort 事件，转发到内部 controller
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer)
      return { ok: false, error: 'external_signal_aborted' }
    }
    opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const body: Record<string, unknown> = {
      model: 'deepseek-chat',
      messages,
      temperature: opts.temperature ?? 0.5,
      max_tokens: opts.max_tokens ?? 1500,
    }
    if (opts.jsonMode) {
      body.response_format = { type: 'json_object' }
    }

    const res = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error(`[llm] DeepSeek HTTP ${res.status}:`, errText.slice(0, 200))
      return { ok: false, error: `http_${res.status}` }
    }

    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      console.error('[llm] DeepSeek 返回空 content:', JSON.stringify(data).slice(0, 200))
      return { ok: false, error: 'empty_content' }
    }

    return { ok: true, content: content.trim(), raw: data }
  } catch (e) {
    // AbortError（超时或外部 signal）/ 网络异常 / JSON 解析异常
    const isAbort = e instanceof Error && e.name === 'AbortError'
    const msg = isAbort ? 'timeout' : e instanceof Error ? e.message : String(e)
    console.warn(`[llm] DeepSeek 调用异常 (${msg}):`, e instanceof Error ? e.message : e)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 调用 DeepSeek chat completions。
 *
 * - 内置 timeout：超时触发 abort，返回 { ok: false, error: 'timeout' }
 * - 内置 try/catch：网络异常/非 2xx/坏响应均返回 { ok: false }
 * - 不解析 JSON：返回 content 字符串，由调用方按需 JSON.parse
 * - 失败永不抛错，调用方安全降级
 * - 传了 language 时：注入语言约束 → 校验输出 → 不符则在剩余预算内重试一次
 *
 * @example
 * const res = await callDeepSeekChat({
 *   messages: [{ role: 'system', content: '...' }, { role: 'user', content: '...' }],
 *   jsonMode: true,
 *   language: 'zh-CN',            // 来自 detectLanguage(用户输入)
 *   languageExemptFields: ['slug'],
 * })
 * if (!res.ok) return null // 降级
 */
export async function callDeepSeekChat(
  opts: DeepSeekChatOptions
): Promise<DeepSeekChatResult> {
  const target = opts.language
  // undefined = 调用方自行负责语言（向后兼容）；给定值则本层接管
  const managed = target !== undefined
  const messages = managed
    ? withLanguageDirective(opts.messages, target, {
        exemptFields: opts.languageExemptFields,
      })
    : opts.messages

  const budget = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const startedAt = Date.now()

  const first = await requestOnce(messages, opts, budget)
  if (!first.ok) return first

  // 不需要语言校验的场景：未接管，或目标是 unknown（无法判定，无从校验）
  if (!managed || target === 'unknown') {
    return first
  }

  const check = checkLanguageConsistency(languageSample(first.content, opts.jsonMode), target)
  if (check.consistent) {
    return { ...first, languageCheck: check }
  }

  // ── 语言跑偏：在剩余预算内自纠偏一次 ──
  // 这是"稳定"的最后一道保险：prompt 约束偶尔会被长上下文淹没，
  // 与其把错误语言的内容直接交给用户，不如花一次请求纠正。
  if (opts.languageRetry === false) {
    console.warn(`[llm] language mismatch (retry disabled): ${check.note}`)
    return { ...first, languageCheck: check }
  }

  const remain = budget - (Date.now() - startedAt)
  if (remain < MIN_RETRY_BUDGET_MS) {
    console.warn(`[llm] language mismatch but budget left ${remain}ms < ${MIN_RETRY_BUDGET_MS}ms, keep first result: ${check.note}`)
    return { ...first, languageCheck: check }
  }

  console.warn(`[llm] language mismatch, retry once: ${check.note}`)
  const repair: ChatMessage[] = [
    ...messages,
    // 带上首次输出讓模型只需改写语言，不必重新组织内容（省 token 且保住完整性）
    { role: 'assistant', content: first.content.slice(0, 4000) },
    {
      role: 'user',
      content:
        `你的上一次输出存在语言问题：${check.note}。\n` +
        `请保留刚才输出的全部内容与结构（要点、字段、数量都不能丢），` +
        `仅把面向用户的文字整体改写为 ${languageName(target)}，然后重新完整输出一次。`,
    },
  ]

  const second = await requestOnce(repair, opts, remain)
  // 重试失败 / 重试后仍跑偏都保留首次结果：语言瑕疵好过内容丢失
  if (!second.ok) {
    console.warn(`[llm] language retry failed (${second.error}), keep first result`)
    return { ...first, languageCheck: check }
  }

  const finalCheck = checkLanguageConsistency(languageSample(second.content, opts.jsonMode), target)
  if (!finalCheck.consistent) {
    console.warn(`[llm] language mismatch persisted after retry: ${finalCheck.note}`)
  }
  return { ...second, languageCheck: finalCheck }
}

/**
 * 按 max_tokens 推导单次请求的超时毫秒数（供尚未走 callDeepSeekChat 的直连 fetch 使用）。
 *
 * DeepSeek 输出速率按 30 tok/s 保守估算生成耗时，另加 15s 连接/排队余量，
 * 最终夹取到 [20s, 120s]：短输出快速失败；超长输出（如 7000 tokens 的方案生成）
 * 也不会被过早掐断而改变既有产品行为。
 */
export function llmTimeoutMs(maxTokens: number): number {
  return Math.min(120_000, Math.max(20_000, Math.round(15_000 + (maxTokens / 30) * 1000)))
}

/**
 * 生成带超时的 AbortSignal，直接传给 fetch 的 signal 参数。
 * 用于给历史直连 fetch 补超时边界：请求无限挂起会吃满 serverless 并发并产生
 * 不可控的 token 费用，必须在调用侧设上限。
 */
export function llmTimeoutSignal(maxTokens: number): AbortSignal {
  return AbortSignal.timeout(llmTimeoutMs(maxTokens))
}

/**
 * 辅助：从可能包裹 ```json ... ``` 的字符串中提取 JSON 文本。
 * DeepSeek 即使设了 response_format 仍偶发包裹 markdown，统一清理。
 */
export function stripJsonFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}
