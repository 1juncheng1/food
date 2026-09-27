// ============================================================
// Work Agent · 交互模式路由（纯函数，零 LLM）
//
// 存在意义：用户说出来的不是"需求"，而是"感受"。
//   「我感觉写出来没人看」不是一句修改指令，把它直接送进
//   「澄清候选 → 修改方案 → 段落补丁」流水线，会得到一句
//   「我理解你的反馈，请选择修改方向」——用户要的是有人一起想，
//   系统给的却是一张表单。这就是"AI 窗口"和"创作伙伴"的分界。
//
// 为什么用确定性规则而不是每次都问 LLM：
//   1. 模式判定错误会毁掉整轮对话（陪伴模式被判成改稿，用户会觉得被敷衍）；
//      而规则是可枚举、可回归测试、可解释的
//   2. 判定发生在每次对话的第一步，多一次 LLM 调用 = 多 1-3 秒等待 + 多一份 token
//   3. 判不出来时一律回退 `suggest`（现有流水线），绝不会比改造前更差
//
// 命中即返回，判定顺序即优先级（见 MODE_RULES）。
// ============================================================

import type { InteractionMode } from './workAgent'

/** 判定置信度：rule=规则命中（确定性）；fallback=未命中走默认 */
export type ModeConfidence = 'rule' | 'fallback'

export interface ModeDetection {
  mode: InteractionMode
  /** 为什么判成这个模式（日志与调试用，不直接展示给用户） */
  reason: string
  confidence: ModeConfidence
}

/**
 * 四种输出模式的展示元信息。
 * companion 的 hint 刻意不承诺"帮你改"——陪伴模式先聊，改不改由用户决定。
 */
export const INTERACTION_MODE_META: Record<
  InteractionMode,
  { label: string; hint: string }
> = {
  companion: { label: '创作陪伴', hint: '先聊聊你卡在哪，不急着改稿' },
  discuss: { label: '讨论', hint: '一起分析这篇的问题在哪' },
  suggest: { label: '修改建议', hint: '先理解你的想法，再给可选方案' },
  direct: { label: '直接修改', hint: '跳过讨论，直接出修改建议' },
}

interface ModeRule {
  mode: InteractionMode
  /** 命中其中任一正则即判为该模式 */
  patterns: RegExp[]
  reason: string
}

/**
 * 判定顺序即优先级，改动前先想清楚冲突场景：
 *
 * - `direct` 最高：用户说「别问了直接改」，再给他一轮候选就是违背明示指令
 * - `companion` 次之：情绪/迷茫信号优先于改稿诉求。
 *   反例「写出来没人看，帮我改一下」——用户此刻更需要先被理解，
 *   陪伴回复里会带一个"要不要现在一起改"的下一步，不会把他堵死
 * - `discuss` 再次：用户明确在问"你怎么看"时，不给方案，先回答
 * - `suggest` 兜底（不参与匹配，是缺省值）
 */
const MODE_RULES: ModeRule[] = [
  {
    mode: 'direct',
    patterns: [
      /直接(改|修改|优化|重写|调整)/,
      /(不用|别|不要)(再)?(问|确认|选)了?/,
      /(你|你帮我)(自己)?看着改/,
      /按(你|这个)(说|想)的改/,
      /马上改/,
    ],
    reason: '用户明确要求跳过讨论直接改',
  },
  {
    mode: 'companion',
    patterns: [
      /(没人|没人看|没有人)看/,
      /(没|没有)(流量|反响|反馈|水花)/,
      /(写不出|写不下|写不动|不知道写什么|不知道怎么(写|改))/,
      /(迷茫|焦虑|崩溃|想放弃|坚持不下去|没动力|没意义)/,
      /(是不是)?(我|自己)(写得太差|不适合|不行)/,
      /(怎么|为啥|为什么)没人(看|读|理)/,
    ],
    reason: '检测到创作受阻或情绪信号，先陪伴再谈修改',
  },
  {
    mode: 'discuss',
    patterns: [
      /(你(怎么|咋)看|你觉得|你认为)/,
      /帮我(分析|看看|诊断|判断)/,
      /(先|只是)?(聊聊|讨论|商量)一下?/,
      /为什么(会|这样|这么)/,
      /(这样|这么)(写|改)(对|行)吗/,
      /(我|这个)(想法|思路|方向)(对不对|行不行|有问题吗)/,
    ],
    reason: '用户在征询判断，先给分析而不是方案',
  },
]

/** 低于该长度的反馈不做模式判定：单字/单词既无情绪也无指令，判了只会误伤 */
const MIN_TEXT_FOR_DETECTION = 2

/**
 * 判定用户这句话该进入哪种模式。
 *
 * 未命中任何规则时返回 `suggest`（既有三步流水线）——
 * 这条兜底保证本模块永远只会让对话更贴合，不会让既有链路退化。
 */
export function detectInteractionMode(freeText: string): ModeDetection {
  const text = (freeText ?? '').trim()
  if (text.length < MIN_TEXT_FOR_DETECTION) {
    return { mode: 'suggest', reason: '输入过短，走默认修改流程', confidence: 'fallback' }
  }

  for (const rule of MODE_RULES) {
    for (const p of rule.patterns) {
      if (p.test(text)) return { mode: rule.mode, reason: rule.reason, confidence: 'rule' }
    }
  }
  return { mode: 'suggest', reason: '未命中特殊模式，走默认修改流程', confidence: 'fallback' }
}
