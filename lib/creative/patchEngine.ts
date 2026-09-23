// ============================================================
// Patch Engine（修改补丁引擎）—— AI 协作修改系统的核心
//
// 职责：把「用户反馈」转化为「段落级修改补丁」，而不是重写全文。
//   1. splitParagraphs / applyPatches / fuzzyMatchAnchor —— 纯函数，前后端共用
//      （服务端用于落库前融合校验，前端用于即时预览，单一实现保证行为一致）
//   2. generateEditPatches —— 服务端专用，调用 DeepSeek 生成结构化补丁
//
// 设计原则：
//   - 锚点双重校验（段落序号 + 首句摘录模糊匹配），校验失败绝不入库
//   - 补丁只描述「改哪段、改成什么、为什么」，未命中的段落原样保留
//   - 失败降级：全文重写链路（prompt-optimizer improve 模式）始终可用
// ============================================================

import type { FeedbackAnalysis, RevisionPlan } from './workAgent'
import { callDeepSeekChat, llmTimeoutMs, stripJsonFence } from '@/lib/llm'
import { languageDirective, resolveTargetLanguage, type LanguageCode } from '@/lib/languageConsistency'

// ── 1. 类型 ───────────────────────────────────────────────

/** 段落级修改补丁（对应 generation_history.edit_patches jsonb 数组元素） */
export interface ModificationPatch {
  /** 段落序号（1-based，对应 splitParagraphs 的结果下标+1） */
  segmentIndex: number
  /** 锚点：目标段落开头 ≤30 字的原文摘录（LLM 必须逐字复制，服务端校验） */
  segmentExcerpt: string
  /** 被替换的原文摘录（展示对照用，允许为空） */
  originalExcerpt: string
  /** 修改后的完整段落文本（整段替换，非 diff） */
  revisedText: string
  /** AI 的修改理由（一句话，建议窗口展示） */
  reason: string
}

/** 补丁生成输入（服务端 route 组装） */
export interface PatchGenerationInput {
  /** 当前基底全文 */
  content: string
  /** 用户反馈原文 */
  freeText: string
  /** 反馈分析结果（analyze-feedback 输出，可选） */
  analysis?: FeedbackAnalysis | null
  /** 创作主题（可选，帮助 AI 理解上下文） */
  topic?: string
  /** 上一轮被拒补丁（负例：AI 不得重复类似修改，只带最近 1 轮防 prompt 膨胀） */
  rejectedPatches?: ModificationPatch[]
  /** 上一轮已生成的补丁（继续调整时的上下文） */
  previousPatches?: ModificationPatch[]
  /**
   * Work Agent 统一上下文块：诊断 / 原始目标 / 创作者画像 / 编辑偏好 / 个人素材。
   * 由 formatContextForPrompt(ctx, { includeContent: false }) 产出（正文由本函数自带，不重复注入）。
   *
   * 为什么必填（尽管类型上可选以兼容旧调用方）：
   *   没有它，LLM 只知道「一篇匿名文章 + 一句反馈」，改写结果必然退化成通用 AI 腔调——
   *   这是局部修改链路最大的失败模式，也是本次重构要修的核心问题。
   */
  contextText?: string
  /** 用户在阶段 2 确认的修改方案（其 preserveItems 并入硬约束） */
  plan?: RevisionPlan | null
  /**
   * 目标输出语言。不传时自动推断，且**以被改写正文的语言为准**（而非反馈语言）：
   * 英文反馈要求改中文稿件时，补丁必须仍是中文。
   */
  language?: LanguageCode
}

// ── 2. 纯函数：段落切分与融合（前后端共用）────────────────

/**
 * 把 Markdown 全文切分为段落数组。
 * 规则：按空行切分；连续非空行合并为一段；去掉首尾空白与空段。
 * 注意：切分会把原文中连续多行合并（段内换行保留为单段内容），融合后统一以空行重排。
 */
export function splitParagraphs(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/** 归一化：去空白与中英文标点，用于锚点模糊比对 */
function normalizeForMatch(s: string): string {
  return s.replace(/[\s，。！？；：、""''（）《》【】,.!?;:'"()[\]{}<>…·—-]/g, '')
}

function bigramSet(s: string): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}

/**
 * 锚点校验：expected（LLM 声称的段落开头摘录）是否确实指向 actual（真实段落）。
 * 通过条件（满足其一）：
 *   1. 归一化后 actual 以 expected 开头（主路径）
 *   2. 归一化后 actual 包含 expected（LLM 多复制了几个字）
 *   3. expected 与 actual 开头等长区域的 bigram 相似度 ≥ 0.7（LLM 轻微改写摘录）
 *      注意：只取与 expected 等长的区域比对——若用更长前缀，额外字符会稀释 Dice 相似度
 */
export function fuzzyMatchAnchor(expected: string, actual: string): boolean {
  const e = normalizeForMatch(expected)
  const a = normalizeForMatch(actual)
  if (!e || !a) return false
  if (a.startsWith(e) || a.includes(e)) return true
  const region = a.slice(0, e.length + 2)
  const be = bigramSet(e)
  const br = bigramSet(region)
  if (be.size === 0 || br.size === 0) return false
  let inter = 0
  for (const g of be) if (br.has(g)) inter++
  return (2 * inter) / (be.size + br.size) >= 0.7
}

/**
 * 校验补丁序列：序号越界/锚点失配的补丁被剔除，同段重复保留第一条，上限 5 条。
 * 返回有效补丁列表与被剔除数量（route据此决定重试/降级）。
 */
export function validatePatches(
  content: string,
  patches: ModificationPatch[]
): { valid: ModificationPatch[]; rejected: number } {
  const segments = splitParagraphs(content)
  const seen = new Set<number>()
  const valid: ModificationPatch[] = []
  let rejected = 0
  for (const p of patches) {
    if (valid.length >= 5) break
    if (!Number.isInteger(p.segmentIndex) || p.segmentIndex < 1 || p.segmentIndex > segments.length) {
      rejected++
      continue
    }
    if (seen.has(p.segmentIndex)) {
      rejected++
      continue
    }
    if (!fuzzyMatchAnchor(p.segmentExcerpt, segments[p.segmentIndex - 1])) {
      rejected++
      continue
    }
    seen.add(p.segmentIndex)
    valid.push(p)
  }
  return { valid, rejected }
}

/**
 * 局部融合：把有效补丁按段落替换进原文，生成新全文。
 * 纯函数——服务端落库前调用（最后一道校验），前端预览调用（同一实现，所见即所得）。
 * 内部再次逐条校验锚点：任何失配补丁静默跳过（绝不错位替换）。
 */
export function applyPatches(content: string, patches: ModificationPatch[]): string {
  const segments = splitParagraphs(content)
  const { valid } = validatePatches(content, patches)
  for (const p of valid) {
    segments[p.segmentIndex - 1] = p.revisedText.trim()
  }
  return segments.join('\n\n')
}

/** 补丁摘要（落库到 improve_note 用） */
export function summarizePatches(patches: ModificationPatch[]): string {
  if (patches.length === 0) return ''
  return `局部修改 ${patches.length} 段：${patches
    .map((p) => `第${p.segmentIndex}段(${p.reason.slice(0, 20)})`)
    .join('、')}`
}

// ── 3. LLM 输出清洗 ───────────────────────────────────────

/** 兜底清洗 DeepSeek 输出的补丁序列（无效元素剔除，结构缺失返回空） */
export function normalizeEditPatches(
  raw: unknown
): { patches: ModificationPatch[]; summary: string } {
  if (typeof raw !== 'object' || raw === null) return { patches: [], summary: '' }
  const o = raw as Record<string, unknown>

  const s = (v: unknown, max: number): string =>
    typeof v === 'string' ? v.trim().slice(0, max) : ''

  const rawPatches = Array.isArray(o.patches) ? o.patches : []
  const patches: ModificationPatch[] = []
  for (const item of rawPatches) {
    if (typeof item !== 'object' || item === null) continue
    const p = item as Record<string, unknown>
    const segmentIndex = Number(p.segment_index ?? p.segmentIndex)
    const segmentExcerpt = s(p.segment_excerpt ?? p.segmentExcerpt, 60)
    const revisedText = s(p.revised_text ?? p.revisedText, 8000)
    const reason = s(p.reason, 200)
    if (!Number.isFinite(segmentIndex) || !segmentExcerpt || !revisedText || !reason) continue
    patches.push({
      segmentIndex: Math.floor(segmentIndex),
      segmentExcerpt,
      originalExcerpt: s(p.original_excerpt ?? p.originalExcerpt, 2000),
      revisedText,
      reason,
    })
    if (patches.length >= 5) break
  }
  return { patches, summary: s(o.summary, 300) }
}

// ── 4. LLM 调用（仅服务端）────────────────────────────────

const MAX_PATCH_CONTENT_LENGTH = 12000 // 超长文章不适合补丁流（输入截断会破坏段落定位），直接降级

function buildSystemPrompt(lang: LanguageCode): string {
  return [
    '你是文章修改补丁专家。用户对一篇已生成文章提出反馈，',
    '你的任务不是重写全文，而是生成「段落级修改补丁」：只改真正需要改的段落，其余段落原样保留。',
    '',
    languageDirective(lang, { extra: 'revised_text 的语言必须与原文一致，不要翻译语种。' }),
    '',
    '输出规则：',
    '- 用户会提供带编号的段落列表（[1] [2] ...）；segment_index 必须取自该编号（1-based）；',
    '- segment_excerpt 必须逐字复制目标段落的开头 ≤30 字（用作锚点校验，禁止改写、禁止凭记忆编造）；',
    '- revised_text 是修改后该段的完整替换文本（整段内容，不是 diff、不是片段）；',
    '- original_excerpt 从目标段落原文中摘录被替换的核心部分（展示对照用）；',
    '- reason 用一句话说明修改理由；',
    '- 补丁数量 ≤5；没有真正需要修改的段落就不要输出该段；',
    '- 「必须保持不变」清单是硬约束，涉及内容禁止出现在 revised_text 的改动中；',
    '- revised_text 的文风、人称、时态必须与原文一致；',
    '  若上下文给出了创作者画像，改写必须贴合该画像的表达习惯——把作者的个人语感',
    '  改成通用书面腔，等同于改坏了，即使用户没明说这条要求；',
    '- 需要案例/数据支撑时，优先使用上下文「用户个人素材库」里的真实素材；',
    '  素材库没有且你不掌握事实时，禁止编造具体数字、人名、机构名，改为强化论述本身；',
    '- 修改范围优先参考「影响范围」标注的段落位置（如"开头"对应前 1-2 段）；',
    '- 如果反馈本质上需要全文重写（如"换个话题重写"），输出空 patches 数组。',
    '',
    '硬性输出要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释文字；',
    languageDirective(lang),
    '3. JSON 结构：{"patches":[{"segment_index":1,"segment_excerpt":"...","original_excerpt":"...","revised_text":"...","reason":"..."}],"summary":"一句话说明本次共改了什么"}',
  ].join('\n')
}

function buildUserPrompt(input: PatchGenerationInput, segments: string[]): string {
  const lines: string[] = ['请为以下文章生成段落级修改补丁。']

  // 上下文优先：让 LLM 先读完「这篇是谁写的、现在什么毛病、用户最初想表达什么」，
  // 再看那句反馈。顺序反了就会退化成脱离作品的通用改写。
  if (input.contextText) {
    lines.push('', '=== 作品上下文（必须优先遵循）===', input.contextText, '=== 上下文结束 ===')
  }

  lines.push('', `用户反馈原文：${input.freeText}`)
  if (input.topic) lines.push(`创作主题：${input.topic}`)

  // 保持项并集：analysis（AI 自行判断）∪ plan（用户确认的承诺），去重后一次性下发
  const preserve = [
    ...(input.plan?.preserveItems ?? []),
    ...(input.analysis?.preserveItems ?? []),
  ].filter((v, i, a) => v && a.indexOf(v) === i)

  if (input.plan) {
    lines.push(
      '',
      '--- 用户已确认的修改方案（必须按此执行，不得自行扩大范围）---',
      `方案：${input.plan.title}`,
      `做法：${input.plan.description}`,
      input.plan.expectedImpact ? `预期影响：${input.plan.expectedImpact}` : '',
      input.plan.modificationArea.length
        ? `修改范围：${input.plan.modificationArea.join('、')}`
        : '',
      input.plan.risk ? `风险提示：${input.plan.risk}` : ''
    )
  }
  if (input.analysis) {
    lines.push(
      `AI 对反馈的理解：${input.analysis.userIntentSummary}`,
      `优化方向：${input.analysis.intentType}`,
      `具体修改点：${input.analysis.modificationTargets.join('、')}`,
      `优化蓝图：${input.analysis.optimizationBlueprint}`
    )
    if (input.analysis.impactScope?.length) {
      lines.push(`影响范围：${input.analysis.impactScope.join('、')}`)
    }
  }
  if (preserve.length > 0) {
    lines.push(`必须保持不变（硬约束）：${preserve.join('、')}`)
  }

  lines.push('', `--- 文章段落列表（共 ${segments.length} 段）---`)
  segments.forEach((seg, i) => {
    lines.push(`[${i + 1}] ${seg}`)
  })
  lines.push('--- 段落列表结束 ---')

  if (input.previousPatches?.length) {
    lines.push('', '--- 上一轮已生成的补丁（上下文，用户在 此基础上继续调整）---')
    for (const p of input.previousPatches) {
      lines.push(`第${p.segmentIndex}段：${p.reason}（改写要点：${p.revisedText.slice(0, 80)}…）`)
    }
  }
  if (input.rejectedPatches?.length) {
    lines.push('', '--- 上一轮被用户拒绝的补丁（负例，禁止输出类似的修改）---')
    for (const p of input.rejectedPatches) {
      lines.push(`第${p.segmentIndex}段：${p.reason}（被拒改写：${p.revisedText.slice(0, 80)}…）`)
    }
  }
  return lines.join('\n')
}

/**
 * 调用 DeepSeek 生成补丁（强制 JSON，镜像 feedbackAnalyzer 的重试模式）。
 * 温度 0.5：改写需要创造力，但锚点摘录必须逐字复制（靠 normalize 清洗 + 服务端校验兜底）。
 * max_tokens 3000：输出 = ≤5 个整段改写 + 理由，远短于全文重写。
 * 返回 null 表示两轮尝试均未产出任何有效补丁（调用方降级全文重写）。
 */
export async function generateEditPatches(
  input: PatchGenerationInput
): Promise<{ patches: ModificationPatch[]; summary: string } | null> {
  const content = input.content
  const freeText = input.freeText.trim()
  if (!content || freeText.length < 2) return null
  if (content.length > MAX_PATCH_CONTENT_LENGTH) return null

  const segments = splitParagraphs(content)
  if (segments.length < 2) return null // 单段文章无从"局部修改"

  // 输出语言必须以「被改写的正文」为准，而不是用户的反馈。
  // 反例：用户用英文说 "make the ending more emotional"，但稿件本身是中文时，
  // 若按反馈语言生成补丁，就会把整段中文改成英文——这是本链路最严重的失败模式。
  // 反馈只在正文语言判不出时才作为次要依据。
  const target =
    input.language ??
    resolveTargetLanguage([
      { text: content, weight: 100, label: 'article' },
      { text: input.topic, weight: 40, label: 'topic' },
      { text: freeText, weight: 20, label: 'feedback' },
    ]).language

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await callDeepSeekChat({
        messages: [
          { role: 'system', content: buildSystemPrompt(target) },
          { role: 'user', content: buildUserPrompt(input, segments) },
        ],
        temperature: 0.5,
        max_tokens: 3000,
        jsonMode: true,
        language: target,
        // 第二次尝试是兜底重来，不再叠加语言自纠偏，避免把总耗时拖到网关超时
        languageRetry: attempt === 0,
        timeoutMs: attempt === 0 ? 45_000 : llmTimeoutMs(3000),
      })

      if (!res.ok) {
        console.error('补丁生成失败:', res.error)
        return null
      }
      const { patches, summary } = normalizeEditPatches(JSON.parse(stripJsonFence(res.content)))

      // 锚点校验：全部失配 → 重试一次（附上轮被剔信息没有额外通道，靠 LLM 重新对齐）
      if (patches.length === 0) continue
      const { valid } = validatePatches(content, patches)
      if (valid.length > 0) return { patches: valid, summary }
      console.error(
        `补丁锚点全部失配（第 ${attempt + 1} 次尝试，rejected=${patches.length}），重试`
      )
    } catch (e) {
      console.error(`补丁生成异常（第 ${attempt + 1} 次）:`, e)
    }
  }
  return null
}
