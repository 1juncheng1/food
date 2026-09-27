// ============================================================
// Edit Diff（编辑差异信号抽取）—— 纯函数，零 LLM
//
// 存在意义：用户点「我改改」保存下来的 edited_content，过去只被用来算
// revisionCount 之类的统计。但它是**用户亲手写的**——比 AI 生成的任何东西
// 都更可信，是 editingMemory 目前唯一缺的"人写"事件源。
//
// 与 preferenceReason 的分工：
//   preferenceReason：从用户**说的**（反馈原话）抽"为什么改"
//   editDiff：        从用户**做的**（原稿 → 改稿的差异）反推"他想要什么"
//   两者最终都归到同一条 statements → editingMemory 的通道。
//
// 为什么用规则而不是 LLM：
//   ① 编辑保存是高频动作，不能每次都花钱调模型；
//   ② 这里要的是**可复现的结构性信号**（删了什么、变长变短、段落怎么拆），
//      规则比模型更确定，也更好写回归测试；
//   ③ 与 preferenceReason 保持同一范式（语义映射表 + 零 token），口径一致。
//
// 宁缺毋滥：抽不出稳定信号就返回空数组。错误的 statement 一旦过了
// editingMemory 的样本门槛（sourceCount ≥ 2），会长期误导后续生成。
// ============================================================

import type { PreferenceReason } from './preferenceReason'

/** 参与差异比较的最小原稿长度：太短的稿件（标题/口播提纲）算不出稳定信号 */
const MIN_ORIGINAL_LEN = 80
/** 长度变化的相对阈值 + 最小绝对差（避免短文抖几个字就触发） */
const SHRINK_RATIO = 0.85
const GROW_RATIO = 1.15
const MIN_LEN_DELTA = 40
/** 段落数增长判定：至少多 2 段，且达到 1.5 倍 */
const MIN_PARA_DELTA = 2
const PARA_GROW_RATIO = 1.5
/** 单条陈述上限（与 editingMemory 的 statement 上限一致） */
const MAX_STATEMENT_LEN = 50
/** 一次编辑最多产出几条信号：超了说明判定不可靠，宁可不记 */
const MAX_SIGNALS = 5

/**
 * 套路化表达：出现在原稿、却在改稿里消失 → 用户亲手删掉了。
 *
 * 只收录"AI 特别爱写、人类很少留"的那几类。若把所有被删的词都当偏好，
 * 会把"这次用不上"误记成"他不喜欢"，与 preferenceReason 的宁缺毋滥同原则。
 */
const CLICHE_RULES: Array<{ match: RegExp; statement: string; alternative: string }> = [
  {
    match: /首先|其次|再者|最后但同样重要/,
    statement: '套路化顺序连接词（首先/其次）',
    alternative: '直接切入主题的写法',
  },
  {
    match: /综上所述|总而言之|总的来说|一句话概括/,
    statement: '套路化总结词（综上所述）',
    alternative: '自然收束的结尾',
  },
  {
    match: /值得一提的是|不难看出|众所周知|显而易见|需要注意的是/,
    statement: '套路化强调词（值得一提的是）',
    alternative: '让事实自己说话',
  },
  {
    match: /在当今社会|随着.{0,8}的(?:发展|进步|普及)|近年来，/,
    statement: '宏大开场套话（在当今社会）',
    alternative: '从具体场景开场',
  },
  {
    match: /让我们一起|让我们共同|希望(?:这篇)?(?:对)?你(?:有所|有)?帮助/,
    statement: '说教式号召结尾',
    alternative: '留白式结尾',
  },
]

/** emoji / 象形符号块 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u

/** 结尾硬性互动：原稿有、改稿没有 → 用户不想被要求互动 */
const INTERACTIVE_END_RE =
  /(?:你|您)(?:觉得|认为|怎么看|以为如何)|欢迎(?:在)?(?:评论|留言)|记得(?:点赞|关注|收藏)/

/** 统计全局匹配次数（保持原 flags，补 g） */
function countOf(text: string, re: RegExp): number {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const m = text.match(new RegExp(re.source, flags))
  return m ? m.length : 0
}

function countParagraphs(text: string): number {
  return text
    .split(/\n\s*\n|\n/)
    .map((s) => s.trim())
    .filter(Boolean).length
}

/**
 * 从「原稿 → 用户改稿」的差异中抽取偏好信号。
 *
 * 返回形态与 preferenceReason 一致，可直接作为 editingMemory 的 reasons 传入。
 * 无稳定信号时返回空数组（调用方据此跳过写入，不产生噪声样本）。
 */
export function extractEditDiffSignals(
  original: string,
  edited: string
): PreferenceReason[] {
  const before = (original ?? '').trim()
  const after = (edited ?? '').trim()
  // 原稿太短 → 结构信号不可靠；改稿与原稿相同 → 没有差异可分析
  if (before.length < MIN_ORIGINAL_LEN) return []
  if (before === after) return []

  const out: PreferenceReason[] = []
  const push = (r: PreferenceReason): void => {
    if (out.length >= MAX_SIGNALS) return
    out.push({ ...r, statement: r.statement.slice(0, MAX_STATEMENT_LEN) })
  }

  // ── ① 被删掉的套路表达（最强信号：用户逐处清理）──
  for (const rule of CLICHE_RULES) {
    const n0 = countOf(before, rule.match)
    if (n0 === 0) continue
    const n1 = countOf(after, rule.match)
    if (n1 >= n0) continue
    push({
      kind: 'avoid',
      statement: rule.statement,
      alternative: rule.alternative,
      source: `编辑差异：删掉了 ${n0 - n1} 处「${rule.statement}」`,
    })
  }

  // ── ② emoji 被清空 ──
  const e0 = countOf(before, EMOJI_RE)
  const e1 = countOf(after, EMOJI_RE)
  if (e0 > 0 && e1 === 0) {
    push({
      kind: 'avoid',
      statement: 'emoji 装饰',
      alternative: '纯文字表达',
      source: `编辑差异：删掉了全部 ${e0} 个 emoji`,
    })
  }

  // ── ③ 结尾硬性互动被删 ──
  if (INTERACTIVE_END_RE.test(before) && !INTERACTIVE_END_RE.test(after)) {
    push({
      kind: 'avoid',
      statement: '结尾硬性互动提问',
      alternative: '把结论说完整就收尾',
      source: '编辑差异：删掉了结尾的互动号召',
    })
  }

  // ── ④ 篇幅显著缩短 / 变长（二选一，互斥）──
  const delta = after.length - before.length
  const ratio = after.length / before.length
  if (delta < 0 && ratio <= SHRINK_RATIO && -delta >= MIN_LEN_DELTA) {
    push({
      kind: 'like',
      statement: '更精简的表达',
      source: `编辑差异：篇幅删减 ${-delta} 字（剩 ${Math.round(ratio * 100)}%）`,
    })
  } else if (delta > 0 && ratio >= GROW_RATIO && delta >= MIN_LEN_DELTA) {
    push({
      kind: 'like',
      statement: '更充分的展开',
      source: `编辑差异：篇幅补充 ${delta} 字`,
    })
  }

  // ── ⑤ 段落拆得更碎 ──
  const p0 = countParagraphs(before)
  const p1 = countParagraphs(after)
  if (p1 - p0 >= MIN_PARA_DELTA && p1 / Math.max(p0, 1) >= PARA_GROW_RATIO) {
    push({
      kind: 'like',
      statement: '更短的段落节奏',
      source: `编辑差异：段落由 ${p0} 段拆为 ${p1} 段`,
    })
  }

  // 同一陈述只留一条（多个规则可能命中同一 statement）
  const seen = new Set<string>()
  return out.filter((r) => {
    const key = `${r.kind}:${r.statement}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
