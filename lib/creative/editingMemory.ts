// ============================================================
// Editing Memory（编辑偏好记忆）—— 仅服务端
// AI 协作修改系统的"用户修改记忆"层：从每次补丁接受/拒绝事件中
// 聚合用户的编辑偏好，沉淀为 style_profiles.editing_profile（jsonb），
// 在后续生成时注入 prompt（镜像 styleLearning 的 parse/apply/MIN_SAMPLES 范式）。
//
// 事件来源（复用既有业务动作，不引入埋点）：
//   ✅ 接受补丁  weight 高  用户认可 AI 提出的修改方向
//   ❌ 拒绝补丁  weight 低  用户拒绝该修改方向（反向信号）
// 样本太少（samples < 2）时画像不注入，避免一两次行为造成偏见。
// ============================================================

import type { FeedbackAnalysis } from './workAgent'
import type { PreferenceReason } from './preferenceReason'

/** style_profiles.editing_profile 的持久化结构 */
export interface EditingProfileState {
  preferences: EditingPreference[]
  /** 已吸收的事件数（接受+拒绝） */
  samples: number
  updatedAt: string
}

export interface EditingPreference {
  /** like = 用户喜欢/保持的元素；avoid = 用户不想要的表达 */
  type: 'like' | 'avoid'
  /** 偏好陈述（取自 AI 提取的修改点/保持项，如"开头冲突""故事主题"） */
  statement: string
  /** 置信度 0.05~0.95（事件加权更新） */
  confidence: number
  /** 来源事件数 */
  sourceCount: number
  /** 反馈原话摘要（最多保留 5 条，溯源用） */
  examples: string[]
}

/** 最小注入样本数：低于此值不注入 prompt（防单次反馈污染） */
export const MIN_SAMPLES_TO_INJECT = 2

const MAX_PREFERENCES = 20
const MAX_EXAMPLES = 5
const CONF_MIN = 0.05
const CONF_MAX = 0.95

/** 接受事件的权重（对 confidence 拉升力度） */
const ACCEPT_WEIGHT = 0.5
/** 拒绝事件的权重（反向压低力度，略弱于接受——拒绝可能是"这轮改得不好"而非"方向错误"） */
const REJECT_WEIGHT = 0.35

function clampConf(v: number): number {
  if (!Number.isFinite(v)) return CONF_MIN
  return Math.max(CONF_MIN, Math.min(CONF_MAX, v))
}

/** 从 jsonb 安全解析编辑画像（结构缺失/损坏时返回空画像） */
export function parseEditingProfile(raw: unknown): EditingProfileState {
  if (typeof raw !== 'object' || raw === null) {
    return { preferences: [], samples: 0, updatedAt: '' }
  }
  const o = raw as Record<string, unknown>
  const rawPrefs = Array.isArray(o.preferences) ? o.preferences : []
  const preferences: EditingPreference[] = []
  for (const p of rawPrefs) {
    if (typeof p !== 'object' || p === null) continue
    const e = p as Record<string, unknown>
    const type = e.type === 'avoid' ? 'avoid' : e.type === 'like' ? 'like' : null
    const statement = typeof e.statement === 'string' ? e.statement.trim().slice(0, 50) : ''
    const confidence = Number(e.confidence)
    const sourceCount = Number(e.sourceCount)
    const examples = Array.isArray(e.examples)
      ? e.examples.filter((x): x is string => typeof x === 'string').slice(0, MAX_EXAMPLES)
      : []
    if (!type || !statement) continue
    preferences.push({
      type,
      statement,
      confidence: clampConf(confidence),
      sourceCount: Number.isFinite(sourceCount) && sourceCount >= 0 ? sourceCount : 0,
      examples,
    })
  }
  const samples = Number(o.samples)
  return {
    preferences: preferences.slice(0, MAX_PREFERENCES),
    samples: Number.isFinite(samples) && samples >= 0 ? samples : 0,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
  }
}

/** 陈述归一化（匹配已有偏好用：去空白/标点差异） */
function normalizeStatement(s: string): string {
  return s.replace(/[\s，。！？；：、,.!?;:'"()（）]/g, '')
}

/**
 * 应用一次补丁决策事件，返回新画像（纯函数，便于推理与测试）。
 *
 * 语义：
 *   - accept：AI 提出的修改点（modificationTargets）→ like 强化（用户认可往这个方向改）；
 *     preserveItems → like 强化（用户确认要保持的内容）；
 *     reasons（"为什么改"）→ 按语义写入：avoid 记他不要什么，同时把
 *     alternative 作为 like 记下他真正要什么
 *   - reject：modificationTargets → avoid 强化（用户拒绝往这个方向改，下次少提）
 *
 * 为什么 reasons 只在 accept 时生效：
 *   用户拒绝这次改动，说明"这次改得不好"，不等于"他不想要他说的那个东西"。
 *   把拒绝时的原话也当成偏好，会把"改坏了"误记成"不想要"。
 */
export function applyMemoryEvent(
  prev: EditingProfileState,
  event: {
    accepted: boolean
    freeText: string
    analysis?: FeedbackAnalysis | null
    /** 从反馈原话抽出的"为什么改"（见 preferenceReason.ts） */
    reasons?: PreferenceReason[]
  }
): EditingProfileState {
  const preferences = prev.preferences.map((p) => ({ ...p, examples: [...p.examples] }))
  const example = event.freeText.trim().slice(0, 80)

  const upsert = (type: 'like' | 'avoid', statement: string) => {
    const key = normalizeStatement(statement)
    if (!key) return
    const found = preferences.find(
      (p) => p.type === type && normalizeStatement(p.statement) === key
    )
    if (found) {
      // 置信度渐近拉升：同向事件越多拉动越缓，逼近但达不到 1
      const w = type === 'like' ? ACCEPT_WEIGHT : REJECT_WEIGHT
      found.confidence = clampConf(
        found.confidence + (1 - found.confidence) * (w / (found.sourceCount + 2))
      )
      found.sourceCount += 1
      if (example && !found.examples.includes(example)) {
        found.examples.unshift(example)
        if (found.examples.length > MAX_EXAMPLES) found.examples.length = MAX_EXAMPLES
      }
    } else {
      // 新偏好：起始置信度 0.55（单条不足以注入，等第二次确认）
      preferences.push({
        type,
        statement: statement.slice(0, 50),
        confidence: 0.55,
        sourceCount: 1,
        examples: example ? [example] : [],
      })
    }
  }

  const analysis = event.analysis
  if (event.accepted) {
    for (const t of analysis?.modificationTargets ?? []) upsert('like', t)
    for (const t of analysis?.preserveItems ?? []) upsert('like', t)
    // "为什么改"比"改了什么"更值得记：
    // 「不要太像新闻」→ avoid「新闻通稿式口径」+ like「带个人观点的表达」。
    // 只记 avoid 的话，AI 只知道不该做什么，不知道该往哪走。
    for (const r of event.reasons ?? []) {
      if (r.kind === 'avoid') {
        upsert('avoid', r.statement)
        if (r.alternative) upsert('like', r.alternative)
      } else {
        upsert('like', r.statement)
      }
    }
  } else {
    for (const t of analysis?.modificationTargets ?? []) upsert('avoid', t)
  }

  // 截断：置信度低的沉底淘汰
  const trimmed = preferences
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_PREFERENCES)

  return {
    preferences: trimmed,
    samples: prev.samples + 1,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 格式化编辑画像为注入生成链路的 prompt 块。
 * samples < MIN_SAMPLES_TO_INJECT 或无有效偏好时返回空串（不注入）。
 */
export function formatEditingProfileForPrompt(state: EditingProfileState): string {
  if (state.samples < MIN_SAMPLES_TO_INJECT) return ''
  const likes = state.preferences.filter((p) => p.type === 'like' && p.sourceCount >= 2)
  const avoids = state.preferences.filter((p) => p.type === 'avoid' && p.sourceCount >= 2)
  if (likes.length === 0 && avoids.length === 0) return ''

  const lines: string[] = [
    `【该创作者的修改偏好（来自其 ${state.samples} 次真实修改行为，置信度加权）】`,
  ]
  if (likes.length > 0) {
    lines.push('用户多次修改后表现出喜欢的方向（优先遵循）：')
    for (const p of likes.slice(0, 5)) {
      lines.push(`  - ${p.statement}（${Math.round(p.confidence * 100)}% 置信，${p.sourceCount} 次确认）`)
    }
  }
  if (avoids.length > 0) {
    lines.push('用户多次拒绝的表达（硬性避免）：')
    for (const p of avoids.slice(0, 5)) {
      lines.push(`  - 避免：${p.statement}（${Math.round(p.confidence * 100)}% 置信，${p.sourceCount} 次拒绝）`)
    }
  }
  lines.push('── 以上偏好来自用户真实修改行为，优先级高于通用创作建议。──')
  return lines.join('\n')
}
