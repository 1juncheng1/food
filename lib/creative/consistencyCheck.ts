// ============================================================
// Consistency Check —— 创作一致性诊断：「这篇内容像不像这个用户写的」
//
// 存在理由：
//   现有诊断（三镜头：观点 / 证据 / 表达）回答的是「这篇作品好不好」，
//   回答不了「这篇像不像我」。后者才是 Creator Intelligence 的核心承诺：
//   如果生成的内容总是"通顺但不像我"，用户最终还是会自己重写一遍。
//
// 本模块只做「可判定的三问」，且刻意不做语义判断：
//   1. 知识一致性：有没有用上用户已确认的知识（concept 短名可字面匹配）
//   2. 兴趣一致性：有没有落在用户长期关注的领域（领域名可字面匹配）
//   3. 观点一致性：有没有踩到用户明确排除的内容（硬禁忌可字面匹配）
//
// 为什么不用 LLM 判这三条：
//   ① 诊断已经花了一次 LLM 调用，再加一次是纯成本；
//   ② 知识概念 / 领域名 / 禁忌词都是可枚举实体，字面匹配的召回率足够，
//      而且结果可复现、可测试 —— LLM 判同样的东西无法写回归测试；
//   ③ 「像不像用户」如果给出无法解释的结论，用户没法据此行动。
//   代价是观点一致性只能判"有没有踩雷"，判不了"立场对不对"，
//   这一点在 verdict='unknown' 与文案里明确说破，绝不假装判过。
//
// 设计铁律：
//   1. 纯函数：不读库、不调 LLM。调用方负责把已确认知识/兴趣/禁忌查出来传进来。
//   2. 没有数据就回 unknown，绝不用"看起来还行"糊过去。
//   3. 判定失败的诚实度 > 覆盖率：宁可 unknown，不可误判。
// ============================================================

// ── 类型 ───────────────────────────────────────────────────

export type ConsistencyVerdict =
  /** 命中：本篇确实用上了用户的知识 / 落在关注领域 */
  | 'aligned'
  /** 部分命中：主题相关但正文没展开，或只沾边 */
  | 'partial'
  /** 不符：完全没用上，或踩到了硬禁忌 */
  | 'off'
  /** 无法判断：用户侧没有可比对的数据，或本条需要语义判断 */
  | 'unknown'

export interface ConsistencyItem {
  verdict: ConsistencyVerdict
  /** 人可读的结论说明（直接展示给用户） */
  detail: string
  /** 命中的具体项（展示"凭什么这么判"） */
  hits: string[]
}

export interface ConsistencyCheck {
  /** 是否用了你已确认的知识 */
  knowledge: ConsistencyItem
  /** 是否落在你长期关注的领域 */
  interest: ConsistencyItem
  /** 是否踩到你明确排除的内容 */
  viewpoint: ConsistencyItem
  /** 三条里是否有任何一条可判定（决定 UI 是否展示该区块） */
  hasAnySignal: boolean
}

export interface ConsistencyInput {
  /** 作品正文 */
  text: string
  /** 本次主题（用于"主题相关但正文未展开"的判定） */
  topic?: string
  /** 已确认的知识单元（concept 是聚合短名，可字面匹配） */
  knowledge?: Array<{ concept?: string; domainScope?: string[] }>
  /** 长期关注领域名 */
  interestTopics?: string[]
  /** 硬禁忌（用户声明的排斥内容 + 高置信拒绝过的改法） */
  hardAvoids?: string[]
}

// ── 内部工具 ───────────────────────────────────────────────

/** 归一化：去空白与常见标点，让"真实案例 "能匹配正文里的"真实案例，" */
function norm(s: string): string {
  return s.replace(/[\s，。！？；：、,.!?;:'"()（）《》]/g, '').toLowerCase()
}

function includesTerm(haystack: string, term: string): boolean {
  const t = norm(term)
  if (t.length === 0) return false
  return norm(haystack).includes(t)
}

function uniq(items: string[]): string[] {
  return Array.from(new Set(items.filter((x) => x.length > 0)))
}

// ── 三问 ───────────────────────────────────────────────────

function checkKnowledge(input: ConsistencyInput): ConsistencyItem {
  const units = (input.knowledge ?? []).filter((u) => (u.concept ?? '').trim().length > 0)
  if (units.length === 0) {
    return {
      verdict: 'unknown',
      detail: '你还没有确认过的知识单元，无法判断本篇是否用上了你的知识',
      hits: [],
    }
  }

  const text = input.text ?? ''
  const hits = uniq(units.filter((u) => includesTerm(text, u.concept!)).map((u) => u.concept!))
  if (hits.length > 0) {
    return {
      verdict: 'aligned',
      detail: `用上了你已确认的 ${hits.length} 条知识`,
      hits: hits.slice(0, 5),
    }
  }

  // 正文没出现，但主题可能仍落在知识适用范围 —— 这是"没用上"而非"不相关"
  const topic = input.topic ?? ''
  const inScope = units.some((u) =>
    (u.domainScope ?? []).some((d) => includesTerm(topic, d))
  )
  return inScope
    ? {
        verdict: 'partial',
        detail: '本次主题落在你的知识范围内，但正文没有出现你已确认的知识',
        hits: [],
      }
    : {
        verdict: 'off',
        detail: '既没有用上你已确认的知识，主题也不在你已确认的知识范围内',
        hits: [],
      }
}

function checkInterest(input: ConsistencyInput): ConsistencyItem {
  const topics = uniq((input.interestTopics ?? []).map((t) => t.trim()))
  if (topics.length === 0) {
    return {
      verdict: 'unknown',
      detail: '还没有归纳出你的长期关注领域，无法判断本篇是否符合你的兴趣',
      hits: [],
    }
  }

  const text = input.text ?? ''
  const inText = topics.filter((t) => includesTerm(text, t))
  if (inText.length > 0) {
    return {
      verdict: 'aligned',
      detail: `落在你长期关注的领域：${inText.slice(0, 3).join('、')}`,
      hits: inText.slice(0, 5),
    }
  }

  const topic = input.topic ?? ''
  const inTopic = topics.filter((t) => includesTerm(topic, t))
  return inTopic.length > 0
    ? {
        verdict: 'partial',
        detail: `主题属于你关注的「${inTopic[0]}」，但正文没有真正展开`,
        hits: inTopic.slice(0, 3),
      }
    : {
        verdict: 'off',
        detail: '本篇与你长期关注的领域没有交集（新探索不算问题，但 AI 无法据此学习你的偏好）',
        hits: [],
      }
}

function checkViewpoint(input: ConsistencyInput): ConsistencyItem {
  const avoids = uniq((input.hardAvoids ?? []).map((a) => a.trim()))
  if (avoids.length === 0) {
    return {
      verdict: 'unknown',
      detail: '你还没有明确排除过内容；立场是否一致需要语义判断，本版不做猜测',
      hits: [],
    }
  }

  const text = input.text ?? ''
  const hits = avoids.filter((a) => includesTerm(text, a))
  if (hits.length > 0) {
    return {
      verdict: 'off',
      detail: `出现了你明确排除的内容：${hits.slice(0, 3).join('、')}`,
      hits: hits.slice(0, 5),
    }
  }

  return {
    verdict: 'unknown',
    detail: '没有踩到你明确排除的内容；立场本身是否一致需要语义判断，本版不做猜测',
    hits: [],
  }
}

// ── 主函数 ─────────────────────────────────────────────────

/**
 * 判定一篇作品与用户的创作一致性（纯函数）。
 * 任何一路数据缺失都返回 unknown，绝不抛异常、绝不猜测。
 */
export function checkConsistency(input: ConsistencyInput): ConsistencyCheck {
  const knowledge = checkKnowledge(input)
  const interest = checkInterest(input)
  const viewpoint = checkViewpoint(input)

  return {
    knowledge,
    interest,
    viewpoint,
    hasAnySignal: [knowledge, interest, viewpoint].some((i) => i.verdict !== 'unknown'),
  }
}

/** 展示用：结论文案与配色（前端不要用数字分数，避免伪精确） */
export const CONSISTENCY_VERDICT_META: Record<
  ConsistencyVerdict,
  { label: string; tone: 'good' | 'warn' | 'bad' | 'muted' }
> = {
  aligned: { label: '一致', tone: 'good' },
  partial: { label: '部分一致', tone: 'warn' },
  off: { label: '不一致', tone: 'bad' },
  unknown: { label: '暂无法判断', tone: 'muted' },
}
