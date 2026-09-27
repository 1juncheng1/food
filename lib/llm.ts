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
// 只引入类型与纯函数（无服务端依赖），用于把 token 用量带回调用方按量扣积分
import { ZERO_USAGE, addUsage, type TokenUsage } from '@/lib/balance'
// 请求级 AI 总预算：整条请求共享一个 deadline，重试循环不会把总耗时撑爆
// 路由 maxDuration（否则进程被平台硬杀，预扣的钱退不回来）。见 aiDeadline.ts
import { MIN_CALL_BUDGET_MS, llmBudgetMs, remainingAiBudgetMs } from './aiDeadline'
// Phase 4：AI 计费钩子（调用前预扣 + 调用后按量结算）。
// 传了 billing 的调用自动计费；没传的行为与改造前完全一致——
// 存量调用点不必一次性全改，接一个算一个。
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  refundAiCost,
  reserveAiCost,
  settleAiCost,
  type AiAbility,
} from '@/lib/aiCost'

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

  // ── 积分计费（可选，不传则完全不计费，行为与改造前一致）──────────
  /**
   * 传了就会自动完成「调用前预扣 → 调用后按真实 token 结算 → 失败全额退」。
   *
   * 关键顺序：**预扣成功后才发起 HTTP 请求**。预扣失败（余额不足）时
   * 直接返回 insufficient_points，一个 token 都不花——这比"先生成再发现没钱"
   * 省钱得多，也是需求 §18 的硬性要求。
   */
  billing?: {
    supabase: SupabaseClient
    userId: string
    /** 能力档位，决定预扣多少（读 point_config，不在代码里写死） */
    ability: AiAbility
    /** 业务号：同一次生成/诊断内多次调用可共用一个号，也是幂等键 */
    refId: string
    description?: string
  }
}

/** 统一返回结构：成功带 content，失败带 error */
export type DeepSeekChatResult =
  | {
      ok: true
      content: string
      raw: unknown
      languageCheck?: ConsistencyCheck
      /** 本次调用的 token 用量（用于按量扣积分）；缺失时按零用量处理 */
      usage?: TokenUsage
    }
  | { ok: false; error: string }

/**
 * 从 OpenAI 兼容响应里抽 token 用量。
 *
 * DeepSeek 的 usage 除标准的 prompt/completion 外，还会给出
 * prompt_cache_hit_tokens / prompt_cache_miss_tokens。两档价格差 50 倍，
 * 必须分开计。没给细分字段时，全部输入按「未命中」计——
 * 这是已知信息下唯一不会低估成本的算法（宁可高估，不可漏算）。
 */
/**
 * 从 DeepSeek 响应里取出 token 用量。
 * 对外导出：少数生成器（plan / diagnosis）直接 fetch DeepSeek 而非走
 * callDeepSeekChat，它们同样要按真实用量结算，必须用同一套解析口径。
 */
export function parseUsage(data: unknown): TokenUsage {
  const u = (data as { usage?: Record<string, unknown> } | null)?.usage
  if (!u) return ZERO_USAGE
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const prompt = n(u.prompt_tokens)
  const cached = n(u.prompt_cache_hit_tokens)
  const miss = n(u.prompt_cache_miss_tokens)
  return {
    cachedTokens: cached,
    missTokens: miss > 0 ? miss : Math.max(0, prompt - cached),
    outputTokens: n(u.completion_tokens),
  }
}

// 单次调用的超时预算由 ./aiDeadline 定义（请求级 deadline 也在那里）——
// 这里重新导出，让既有的 `import { llmBudgetMs } from '@/lib/llm'` 不受影响。
export { llmBudgetMs }
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions'

/**
 * LLM 失败原因 → 用户可读文案。
 *
 * 为什么要有这张表：DeepSeek 余额耗尽时返回 HTTP 402（body 为
 * {"error":{"message":"Insufficient Balance"}}），早期代码把所有非 2xx 统一降级成
 * 「诊断失败，请稍后重试」。用户反复重试、反复失败，却完全不知道是**没充钱**——
 * 运营侧也收不到任何信号。失败原因必须区分对待，尤其是「钱不够」这种只有人能修的。
 */
const LLM_USER_MESSAGES: Record<string, string> = {
  http_402: 'AI 服务额度不足，请充值后重试',
  http_401: 'AI 服务凭证无效，请联系管理员',
  http_403: 'AI 服务凭证无效，请联系管理员',
  http_429: 'AI 服务繁忙，请稍后再试',
  http_500: 'AI 服务暂时不可用，请稍后重试',
  http_502: 'AI 服务暂时不可用，请稍后重试',
  http_503: 'AI 服务暂时不可用，请稍后重试',
  http_504: 'AI 服务响应超时，请稍后重试',
  timeout: 'AI 服务响应超时，请稍后重试',
  network_error: '网络异常，AI 服务未能响应，请稍后重试',
  missing_api_key: 'AI 服务未配置，请联系管理员',
  empty_content: 'AI 返回内容为空，请稍后重试',
  external_signal_aborted: '请求已取消',
  // Phase 4：不是 LLM 的错，是用户积分不够——必须在文案里指向"充值"，
  // 否则用户只会反复重试，永远不知道卡在哪一步。
  insufficient_points: '当前积分不足，请充值后继续创作。',
}

/**
 * 把 LLM 错误码翻译成面向用户的中文文案。
 * 未知码（如 http_418）按服务端故障处理，但文案里保留原因便于求助定位。
 */
export function llmUserMessage(error: string | null | undefined): string {
  if (!error) return 'AI 服务暂时不可用，请稍后重试'
  if (LLM_USER_MESSAGES[error]) return LLM_USER_MESSAGES[error]
  if (error.startsWith('http_')) {
    const status = error.slice(5)
    // 5xx = 服务端故障（可重试）；4xx = 请求被拒（多为配额/参数问题）
    return /^5/.test(status)
      ? 'AI 服务暂时不可用，请稍后重试'
      : `AI 服务请求被拒绝（${status}），请稍后重试`
  }
  return 'AI 服务暂时不可用，请稍后重试'
}

/** 判定错误码是否属于「网络/传输」类（连不上，而不是被拒绝） */
export function isLlmNetworkError(error: string | null | undefined): boolean {
  return error === 'network_error' || error === 'timeout'
}

// ── 最近一次 LLM 失败原因（best-effort 传播）──────────────────────
//
// 老链路的 lib 函数（generatePlan / generateBlueprint / marketAnalyzer …）
// 签名是 `T | null`：失败只返回 null，原因被吞掉，路由只能给"请稍后重试"。
// 逐个改签名要动几十个文件，代价大。这里用进程级最近失败码做**兜底传播**：
// 路由在 AI 调用返回 null 后读取它，把「额度不足」这类只有人能修的原因说出来。
//
// 局限：并发下可能读到别的请求的失败码。实践中无害——402（余额耗尽）是全局性
// 故障，同进程内几乎所有请求都会拿到同一个码；且它只影响文案，不影响控制流。
let lastFailure: { code: string; at: number } | null = null

/** 记录一次 LLM 失败码（供 lib/apiAuth 的 aiFailureResponse 读取） */
export function recordLlmFailure(code: string): void {
  lastFailure = { code, at: Date.now() }
}

/**
 * 取最近一次 LLM 失败码。超过时间窗就当作没有——避免把很久以前的
 * 402 当成当前失败的原因，误导用户以为刚刚还在欠费。
 */
export function recentLlmFailure(maxAgeMs = 10_000): string | null {
  if (!lastFailure) return null
  if (Date.now() - lastFailure.at > maxAgeMs) return null
  return lastFailure.code
}

/** 归一化网络类异常名：各环境 message 不同（fetch failed / ETIMEDOUT …），统一成一个码 */
function normalizeCatchError(e: unknown): string {
  const isAbort = e instanceof Error && e.name === 'AbortError'
  if (isAbort) return 'timeout'
  const msg = e instanceof Error ? e.message : String(e)
  if (/fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
    return 'network_error'
  }
  return msg || 'unknown_error'
}

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
      // 402 = Insufficient Balance：余额耗尽。它和超时/网络抖动不同——
      // 重试永远不会好，必须让人来充值，所以要在日志里一眼可辨。
      console.error(`[llm] DeepSeek HTTP ${res.status}:`, errText.slice(0, 200))
      const code = `http_${res.status}`
      recordLlmFailure(code)
      return { ok: false, error: code }
    }

    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      console.error('[llm] DeepSeek 返回空 content:', JSON.stringify(data).slice(0, 200))
      return { ok: false, error: 'empty_content' }
    }

    return { ok: true, content: content.trim(), raw: data, usage: parseUsage(data) }
  } catch (e) {
    // AbortError（超时或外部 signal）/ 网络异常 / JSON 解析异常。
    // 归一成固定错误码，便于上层给出准确文案（而不是把 "fetch failed" 直接甩给用户）
    const code = normalizeCatchError(e)
    console.warn(`[llm] DeepSeek 调用异常 (${code}):`, e instanceof Error ? e.message : e)
    recordLlmFailure(code)
    return { ok: false, error: code }
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
  const billing = opts.billing

  // ── 阶段零：请求级总预算检查 ────────────────────────────────
  // 位置是这里的关键：必须在预扣**之前**。
  //   预扣之后若进程被平台硬杀，退款代码根本跑不到，用户白扣钱。
  //   在这里放弃则一次都没扣——"没扣"不可能失效，"扣了再退"有可能失效。
  // 典型触发场景是重试循环：第 1 次慢但成功返回了无效内容，
  //   此时剩余时间已不够再跑一次，硬发起只会被平台杀在半路。
  const remaining = remainingAiBudgetMs()
  if (remaining !== null && remaining < MIN_CALL_BUDGET_MS) {
    console.warn(
      `[llm] 请求级 AI 预算耗尽（剩余 ${remaining}ms < ${MIN_CALL_BUDGET_MS}ms），放弃本次调用（未预扣）`
    )
    return { ok: false, error: 'timeout' }
  }

  // ── 阶段一：调用前预扣 ──────────────────────────────────────
  // 余额不足时直接返回，**不发起任何 HTTP 请求**：先生成再发现没钱，
  // 那笔 token 成本就是平台自己吞了（需求 §18 明确禁止）。
  let reserved = 0
  if (billing) {
    const reservedResult = await reserveAiCost({
      supabase: billing.supabase,
      userId: billing.userId,
      ability: billing.ability,
      refId: billing.refId,
      description: billing.description,
    })
    if (!reservedResult.ok) {
      // 刻意不调 recordLlmFailure：这不是 LLM 故障，
      // 写进"最近一次 LLM 失败码"会让并发中的其它链路误报成 402。
      return { ok: false, error: 'insufficient_points' }
    }
    // duplicated（同一 refId 已经预扣过）时 reserved 会是 0：
    // 本次调用不再记账也不退款——否则会把前一次扣的钱"退"掉，凭空造积分。
    // 因此调用方要保证**每次调用用不同的 refId**（循环里带 attempt 后缀）。
    reserved = reservedResult.reserved
  }

  const result = await callDeepSeekChatInner(opts)

  // ── 阶段二：按真实用量结算 / 失败全额退 ──────────────────────
  if (billing && reserved > 0) {
    if (result.ok) {
      await settleAiCost({
        supabase: billing.supabase,
        userId: billing.userId,
        refId: billing.refId,
        reserved,
        usage: result.usage ?? ZERO_USAGE,
        description: billing.description,
      })
    } else {
      await refundAiCost({
        supabase: billing.supabase,
        userId: billing.userId,
        refId: billing.refId,
        amount: reserved,
        reason: `AI 调用失败（${result.error}），预扣全额退还`,
      })
    }
  }

  return result
}

/**
 * 真正的 LLM 调用逻辑（不含计费）。
 * 外部一律用 callDeepSeekChat —— 只有它保证"预扣成功才花钱"。
 */
async function callDeepSeekChatInner(
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

  // 未显式指定时用全局预算（上限受 AI_TIMEOUT_BUDGET_MS 约束，见 llmBudgetMs）。
  // 再与请求级剩余预算取 min：重试时不可能再拿到一整份完整预算，
  // 否则多次尝试累加会撑爆路由 maxDuration，进程被杀 → 预扣退不回。
  const remaining = remainingAiBudgetMs()
  const budget = Math.min(
    opts.timeoutMs ?? llmBudgetMs(),
    remaining ?? Number.POSITIVE_INFINITY
  )
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
  // 两次请求都真实花钱：用量必须累加，否则自纠偏那次等于平台白送
  return {
    ...second,
    languageCheck: finalCheck,
    usage: addUsage(first.usage ?? ZERO_USAGE, second.usage ?? ZERO_USAGE),
  }
}

/**
 * 按 max_tokens 推导单次请求的超时毫秒数（供尚未走 callDeepSeekChat 的直连 fetch 使用）。
 *
 * DeepSeek 输出速率按 30 tok/s 保守估算生成耗时，另加 15s 连接/排队余量，
 * 最终夹取到 [20s, llmBudgetMs(maxDurationSec)]：短输出快速失败；超长输出
 * （如 7000 tokens 的方案生成）也不会被过早掐断而改变既有产品行为。
 *
 * 上限从写死的 120s 改为预算：120s 超过了站内多数路由的 maxDuration，
 * 会触发"平台先杀进程、预扣积分退不回"的账单事故。详见 llmBudgetMs。
 *
 * @param maxDurationSec 调用方所在路由的 maxDuration。必须传——
 *   不传会落到 25s 兜底，长输出任务会被过早掐断。
 */
export function llmTimeoutMs(maxTokens: number, maxDurationSec?: number): number {
  return Math.min(
    llmBudgetMs(maxDurationSec),
    Math.max(20_000, Math.round(15_000 + (maxTokens / 30) * 1000))
  )
}

/**
 * 生成带超时的 AbortSignal，直接传给 fetch 的 signal 参数。
 * 用于给历史直连 fetch 补超时边界：请求无限挂起会吃满 serverless 并发并产生
 * 不可控的 token 费用，必须在调用侧设上限。
 */
export function llmTimeoutSignal(maxTokens: number, maxDurationSec?: number): AbortSignal {
  return AbortSignal.timeout(llmTimeoutMs(maxTokens, maxDurationSec))
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
