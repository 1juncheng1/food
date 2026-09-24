// ============================================================
// Feedback Alignment（反馈方向一致性校验）—— Work Agent 验收层
//
// 解决的问题：改完之后没人验证「到底改没改、改的方向对不对」。
//   之前整条链路是单向的：用户说想法 → AI 出方案 → 落新版本 → 结束。
//   新版本生成出来就默认"改好了"，用户只能自己通读全文去发现
//   "AI 压根没按我说的改"或"顺手把我要求保留的部分也改了"。
//
// 本模块是这条链路的闭环：拿「用户反馈」当验收标准，逐条核对新版本，
// 输出可展示的结论（分数 + 逐条命中情况 + 保持项是否被破坏）。
//
// 设计原则：
//   1. 结论必须由代码裁定，不采信 LLM 的自我评分（LLM 打分偏乐观是通病）
//   2. 确定性预检优先：一眼能判定的（全文没变）不浪费一次 LLM
//   3. 校验失败返回 null，调用方静默跳过——校验是增强，绝不能阻塞主流程
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { callDeepSeekChat, llmTimeoutMs } from '@/lib/llm'
import { languageDirective, resolveTargetLanguage, type LanguageCode } from '@/lib/languageConsistency'

/** 结论档位：完全符合 / 部分符合 / 跑偏 */
export type AlignmentVerdict = 'aligned' | 'partial' | 'off'

/** 单个修改点的核对结果 */
export interface AlignmentTargetResult {
  /** 修改点原文（来自用户反馈或方案） */
  target: string
  /** 新版本是否落实了该修改点 */
  hit: boolean
  /** 判定依据（引用新版本里的具体位置/写法，便于用户复核） */
  evidence: string
}

/** 单个"必须保持不变"项的核对结果 */
export interface PreserveResult {
  item: string
  /** 是否被破坏 */
  intact: boolean
  note: string
}

export interface AlignmentReport {
  /** 0-100 方向符合度 */
  score: number
  verdict: AlignmentVerdict
  /** 逐条修改点的命中情况 */
  addressed: AlignmentTargetResult[]
  /** 承诺保持不变的内容是否被破坏 */
  preserved: PreserveResult[]
  /** 面向用户的一句话结论 */
  summary: string
}

export interface AlignmentInput {
  /** 用户反馈原文（如"开头不够吸引人"） */
  freeText: string
  /** 方向名 / 方案名（可选，帮助 LLM 理解诉求） */
  intentLabel?: string
  /** 具体修改点（FeedbackAnalysis.modificationTargets 或 plan.title + modificationArea） */
  targets: string[]
  /** 必须保持不变的内容（plan.preserveItems） */
  preserveItems: string[]
  /** 修改前正文 */
  before: string
  /** 修改后正文 */
  after: string
  /** 目标输出语言；不传则从用户反馈推断 */
  language?: LanguageCode
}

/** 判定阈值：命中全部修改点且分数达标才算 aligned；低于 partialFloor 判为跑偏 */
const ALIGNED_SCORE = 70
const PARTIAL_SCORE = 40

/** 参与比对的正文长度上限（防止长文挤爆 token 预算） */
const CONTENT_LIMIT = 4000

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function s(v: unknown, max: number): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''
}

// ── 1. 确定性预检 ──────────────────────────────────────────

/**
 * 新版本是否与上一版实质不同。
 * 只比空白归一化后的文本：排版差异（多一个空行）不该被当成"改过了"。
 */
export function contentChanged(before: string, after: string): boolean {
  return normalizeWs(before) !== normalizeWs(after)
}

/**
 * 由命中情况与分数裁定结论。
 * 不采信 LLM 自评：它给的 score 只作加权输入，档位一律由这里算。
 *
 * 规则（从严）：
 *   - 任一保持项被破坏 → 最多 partial（"改对了但改坏了"不算成功）
 *   - 修改点全命中 且 score ≥ 70 → aligned
 *   - score ≥ 40 → partial
 *   - 其余 → off
 */
export function verdictOf(
  score: number,
  addressed: AlignmentTargetResult[],
  preserved: PreserveResult[]
): AlignmentVerdict {
  const allHit = addressed.length > 0 && addressed.every((a) => a.hit)
  const broken = preserved.some((p) => !p.intact)
  if (allHit && !broken && score >= ALIGNED_SCORE) return 'aligned'
  if (score >= PARTIAL_SCORE) return 'partial'
  return 'off'
}

/**
 * 预检：能确定性判定的情况直接出报告，返回 null 表示需要 LLM 判定。
 * 目前覆盖"新版本与上一版完全一致"——这时候任何修改点都不可能命中，
 * 完全没必要再花一次 LLM 去确认。
 */
export function precheckAlignment(input: AlignmentInput): AlignmentReport | null {
  if (!contentChanged(input.before, input.after)) {
    return {
      score: 0,
      verdict: 'off',
      addressed: input.targets.map((t) => ({
        target: t,
        hit: false,
        evidence: '新版本与上一版内容完全一致，没有发生任何改动',
      })),
      preserved: input.preserveItems.map((p) => ({ item: p, intact: true, note: '内容未变，保持项自然成立' })),
      summary: '新版本与上一版完全一致，这次反馈没有被落实。',
    }
  }
  return null
}

// ── 2. LLM 输出清洗 ────────────────────────────────────────

/**
 * 清洗校验输出。
 * 有效判定：至少有一条 addressed——一条都没核对的报告对用户没有任何价值，
 * 此时返回 null 让调用方跳过展示，而不是展示一个空壳结论。
 */
export function normalizeAlignmentReport(
  raw: unknown,
  input: Pick<AlignmentInput, 'targets' | 'preserveItems'>
): AlignmentReport | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const rawAddressed = Array.isArray(o.addressed) ? o.addressed : []
  const addressed: AlignmentTargetResult[] = []
  for (const item of rawAddressed) {
    if (typeof item !== 'object' || item === null) continue
    const c = item as Record<string, unknown>
    // target 缺失时回落到输入里的修改点（按序对齐）——LLM 偶尔只回 hit/evidence
    const target = s(c.target, 60) || input.targets[addressed.length] || ''
    if (!target) continue
    addressed.push({
      target,
      hit: c.hit === true,
      evidence: s(c.evidence, 200),
    })
    if (addressed.length >= 6) break
  }
  if (addressed.length === 0) return null

  const rawPreserved = Array.isArray(o.preserved) ? o.preserved : []
  const preserved: PreserveResult[] = []
  for (const item of rawPreserved) {
    if (typeof item !== 'object' || item === null) continue
    const c = item as Record<string, unknown>
    const it = s(c.item, 40) || input.preserveItems[preserved.length] || ''
    if (!it) continue
    preserved.push({ item: it, intact: c.intact !== false, note: s(c.note, 200) })
    if (preserved.length >= 4) break
  }

  const rawScore = Number(o.score)
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 50

  return {
    score,
    verdict: verdictOf(score, addressed, preserved),
    addressed,
    preserved,
    summary: s(o.summary, 200) || `方向符合度 ${score} 分。`,
  }
}

// ── 3. Prompt ──────────────────────────────────────────────

const ALIGNMENT_JSON_KEYS =
  'score, addressed[{target,hit,evidence}], preserved[{item,intact,note}], summary'

function buildSystemPrompt(lang: LanguageCode): string {
  return [
    '你是一位严格的审稿编辑，负责验收一次"按用户反馈修改文章"的结果。',
    '你会拿到：用户的反馈原话、要落实的修改点、承诺保持不变的内容、修改前与修改后两版全文。',
    '',
    '验收方式：',
    '1. 逐条判断每个修改点在新版本里是否真的被落实了——只看新版本的实际文本，不听任何解释；',
    '2. evidence 必须引用新版本里的具体写法或位置（例如"新开头第 2 句改为设问句"），写不出依据就判 hit=false；',
    '3. 逐条检查"必须保持不变"的内容是否被改动或删除，被破坏就 intact=false；',
    '4. score 是 0-100 的整体方向符合度：全部落实且未破坏保持项给 85 分以上，',
    '   只落实一部分给 40-70，基本没改或改反了给 30 分以下；',
    '',
    '硬性要求：',
    '- 严禁用"应该已经改了""可能有改善"这类推测充当依据；',
    '- 不要把与反馈无关的润色算作命中；',
    '- 只输出一个 JSON 对象，不要 markdown 代码块、不要任何前后缀文字；',
    languageDirective(lang),
    '- JSON 必须严格包含以下 key：',
    ALIGNMENT_JSON_KEYS,
  ].join('\n')
}

function buildUserPrompt(input: AlignmentInput): string {
  const targets = input.targets.length
    ? input.targets.map((t, i) => `  ${i + 1}. ${t}`).join('\n')
    : '  （用户未给出具体修改点，请直接对照反馈原话判断）'
  const preserves = input.preserveItems.length
    ? input.preserveItems.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
    : '  （本次未承诺保持不变的内容）'
  return [
    `用户的反馈原话：${input.freeText}`,
    input.intentLabel ? `确认的修改方向：${input.intentLabel}` : '',
    '',
    '需要核对的修改点：',
    targets,
    '',
    '承诺保持不变的内容：',
    preserves,
    '',
    '───── 修改前全文 ─────',
    input.before.slice(0, CONTENT_LIMIT),
    '',
    '───── 修改后全文 ─────',
    input.after.slice(0, CONTENT_LIMIT),
    '',
    '请逐条核对并输出验收结论。',
  ]
    .filter(Boolean)
    .join('\n')
}

// ── 4. 校验入口 ────────────────────────────────────────────

/**
 * 校验新版本是否落实了用户的反馈方向。
 *
 * 返回 null 表示「校验不可用」（LLM 失败/输入不足），调用方应静默跳过——
 * 校验是增强能力，失败时绝不能阻塞"新版本已生成"这个既成事实。
 *
 * 温度 0.1：这是判断题不是创作题，要的是稳定一致的判定。
 * max_tokens 800：6 条修改点 × (target+evidence) + 4 条保持项 + summary。
 */
export async function verifyFeedbackAlignment(
  input: AlignmentInput,
  /**
   * Phase 4 计费上下文：传了就对这次一致性校验计费
   * （调用前预扣 → 按真实 token 结算 → 失败全额退）。不传则行为与改造前一致。
   */
  billing?: { supabase: SupabaseClient; userId: string; refId?: string }
): Promise<AlignmentReport | null> {
  const freeText = input.freeText.trim()
  const before = (input.before ?? '').trim()
  const after = (input.after ?? '').trim()
  if (!freeText || !before || !after) return null

  // 确定性预检优先：完全没改的情况不需要 LLM 复核
  const pre = precheckAlignment({ ...input, freeText, before, after })
  if (pre) return pre

  // 验收结论是给用户看的，语言跟随用户反馈（用户用中文提反馈就该看到中文结论）
  const target =
    input.language ?? resolveTargetLanguage([{ text: freeText, weight: 100, label: 'feedback' }]).language

  const maxTokens = 800
  const res = await callDeepSeekChat({
    messages: [
      { role: 'system', content: buildSystemPrompt(target) },
      { role: 'user', content: buildUserPrompt({ ...input, freeText, before, after }) },
    ],
    temperature: 0.1,
    max_tokens: maxTokens,
    jsonMode: true,
    timeoutMs: llmTimeoutMs(maxTokens),
    language: target,
    // 计费钩子：不传 billing 时不产生任何计费副作用
    ...(billing
      ? {
          billing: {
            supabase: billing.supabase,
            userId: billing.userId,
            ability: 'diagnosis' as const,
            refId: `${billing.refId ?? crypto.randomUUID()}:alignment`,
            description: '反馈方向校验',
          },
        }
      : {}),
  })
  if (!res.ok) return null
  try {
    return normalizeAlignmentReport(JSON.parse(res.content), input)
  } catch (e) {
    console.error('方向一致性校验 JSON 解析失败:', e)
    return null
  }
}
