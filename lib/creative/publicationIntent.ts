// ============================================================
// Publication Intent —— 「愿意发布」代理指标（G3）
//
// 存在意义：
//   产品目标是「生成用户愿意发布的文章」。此前这个目标没有任何量化代理指标，
//   因此无法证伪 —— 我们回答不了「这次改动让用户更愿意发布了吗」，
//   也就无法证明自己是「创作伙伴」而不是「写作工具」。
//   本模块把「愿意发布」翻译成一条可观测的行为阶梯。
//
// 设计原则（改动前必读）：
//   1. 意愿 ≠ 结果。发布（我愿不愿意公开）与发布后互动（别人认不认可）必须分开。
//      把互动数算进意愿，等于把产品目标偷换成「帮用户做爆款」——那是背离定位的。
//      互动数据留给 G2 发布诊断消费，不进本分数。
//   2. 分母诚实。分母是「全部创作项目」，包含用户本就无意公开的作品。
//      因此本分数【不可横向跨用户比较】，只能纵向看同一用户的趋势。
//      这是效度边界不是 bug：横向比会把「写商业计划书」的用户判成低分用户。
//   3. 阶梯优先于分数。分数用来看趋势，阶梯用来归因 ——
//      「什么样的作品能走到 published」才是能指导优化的信息。
//   4. 低样本压上限（沿用 interest/confidence 的惯例）：
//      3 个项目以下不允许高置信，否则单次行为就能把分数打满。
//
// 已知近似（改动前必读）：
//   - posts 是硬删除：发布后又删帖在库里查不到，会被当作「从未发布」。
//     要表达「发布了又后悔」的撤回语义，需要把 work_publish 事件补进
//     creator_events（append-only），本版不做，等 G2 一起评估。
//   - creator_events 当前没有发布事件，published 事实来自
//     posts.source_project_id —— 这是现在唯一可追溯的发布证据。
//   - 只统计有 projectId 的作品（当前所有生成都会建项目）。
//     无项目的老作品需先走 /api/creative/projects/adopt 纳入，才进入分母。
// ============================================================

import type { createServerClient } from '@/lib/supabaseServer'

// ─────────────────────────── 常量（本模块唯一允许出现数字处）───────────────────────────

/** 分数权重：发布是最强意愿信号，定稿次之，认可再次 */
const SCORE_WEIGHTS = { publish: 0.45, finalize: 0.3, approval: 0.25 }

/** 负向折扣系数：negativeRate=1 时总分打五折（否定是折扣，不是独立负维度） */
const NEGATIVE_DISCOUNT = 0.5

/** 置信度：样本量达到该值即视为充分 */
const CONFIDENCE_PROJECT_FULL = 8

/** 置信度：新鲜度窗口（天） */
const CONFIDENCE_FRESH_DAYS = 30

/** 置信度组成权重 */
const CONFIDENCE_WEIGHTS = { volume: 0.75, freshness: 0.25 }

/** 低于该样本量视为低置信 */
const LOW_SAMPLE_MIN_PROJECTS = 3

/** 低样本时置信度硬上限 */
const LOW_SAMPLE_CONFIDENCE_CAP = 0.4

/** 单用户取数上限（与 interestRepo 同口径，防止异常账号拖垮查询） */
const MAX_PROJECTS = 500
const MAX_EVENTS = 2000

// ─────────────────────────── 类型 ───────────────────────────

/**
 * 发布意愿阶梯：L0→L4，每一级都是比上一级更强的「我愿意把它当作我的作品」的信号。
 * 阶梯取最高达成级，不累加。
 */
export type PublicationLadder =
  /** L0 未认领：生成后无任何正向后续动作 */
  | 'unclaimed'
  /** L1 打磨中：有编辑/重生成/共创投入，但尚未认可产出 */
  | 'polishing'
  /** L2 已认可：点了赞，对产出表示满意（尚未定稿） */
  | 'approved'
  /** L3 已定稿：宣布「这是我的成品」 */
  | 'finalized'
  /** L4 已公开：发布到广场，愿意让别人看到 */
  | 'published'

export const LADDER_RANK: Record<PublicationLadder, number> = {
  unclaimed: 0,
  polishing: 1,
  approved: 2,
  finalized: 3,
  published: 4,
}

/** 单个项目的行为事实包（纯计算的输入，可完全由测试构造） */
export interface ProjectIntentFacts {
  projectId: string
  /** 迭代投入：work_edit / work_regenerate / 共创会话落地 */
  edited: boolean
  /** feedback_like：对产出满意 */
  liked: boolean
  /** feedback_dislike / work_delete：明确否定 */
  negative: boolean
  /** 定稿（权威值取 creative_projects.status） */
  finalized: boolean
  /** 发布到广场 */
  published: boolean
  /** 最近一次相关行为时间（ISO）；用于置信度新鲜度 */
  lastActivityAt?: string | null
}

/** 作品级阶梯结果（归因用） */
export interface ProjectLadder {
  projectId: string
  level: PublicationLadder
  rank: number
  negative: boolean
}

export interface IntentInput {
  projects: ProjectIntentFacts[]
  now: Date
}

export interface PublicationIntentReport {
  /** 该用户达成过的最高阶梯 */
  peakLevel: PublicationLadder
  counts: {
    total: number
    polishing: number
    approved: number
    finalized: number
    published: number
    negative: number
  }
  /** 各率均为 0-1，分母恒为 total（全部项目） */
  rates: {
    publish: number
    finalize: number
    approval: number
    negative: number
  }
  /** 0-1 主指标：发布意愿强度 */
  intentScore: number
  /** 0-1 置信度；低样本/长期不活跃时自动压低 */
  confidence: number
  /** 作品级阶梯，供「什么样的作品能走到 published」归因 */
  ladders: ProjectLadder[]
}

// ─────────────────────────── 纯函数 ───────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function round3(n: number): number {
  return Math.round(clamp01(n) * 1000) / 1000
}

/**
 * 单个项目的阶梯判定。
 *
 * 顺序即优先级：published > finalized > approved > polishing > unclaimed。
 * negative 不参与定级 —— 它是「折扣」而非「等级」：
 * 一个先定稿后删除的项目，事实是「曾认可，后放弃」，
 * 阶梯仍记 finalized，同时 negative=true 去打折总分。
 */
export function ladderOf(facts: ProjectIntentFacts): ProjectLadder {
  let level: PublicationLadder = 'unclaimed'
  if (facts.published) level = 'published'
  else if (facts.finalized) level = 'finalized'
  else if (facts.liked) level = 'approved'
  else if (facts.edited) level = 'polishing'

  return {
    projectId: facts.projectId,
    level,
    rank: LADDER_RANK[level],
    negative: facts.negative,
  }
}

function ageDays(iso: string | null | undefined, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
  return (now.getTime() - t) / 86_400_000
}

/**
 * 置信度：样本量为主，新鲜度为辅。
 * 低样本硬压上限，避免「写了 2 篇都发了」就被判定为满分高置信。
 */
function intentConfidence(projects: ProjectIntentFacts[], now: Date): number {
  const total = projects.length
  if (total === 0) return 0

  const volume = Math.min(1, total / CONFIDENCE_PROJECT_FULL)
  const freshCount = projects.filter(
    (p) => ageDays(p.lastActivityAt, now) <= CONFIDENCE_FRESH_DAYS
  ).length
  const freshness = freshCount / total

  let confidence =
    CONFIDENCE_WEIGHTS.volume * volume + CONFIDENCE_WEIGHTS.freshness * freshness

  if (total < LOW_SAMPLE_MIN_PROJECTS) {
    confidence = Math.min(confidence, LOW_SAMPLE_CONFIDENCE_CAP)
  }
  return round3(confidence)
}

const EMPTY_REPORT: PublicationIntentReport = {
  peakLevel: 'unclaimed',
  counts: { total: 0, polishing: 0, approved: 0, finalized: 0, published: 0, negative: 0 },
  rates: { publish: 0, finalize: 0, approval: 0, negative: 0 },
  intentScore: 0,
  confidence: 0,
  ladders: [],
}

/**
 * 计算发布意愿报告。
 *
 * 分数构成：
 *   raw     = 0.45×publishRate + 0.30×finalizeRate + 0.25×approvalRate
 *   score   = raw × (1 − 0.5 × negativeRate)
 *
 * 为什么负向用乘法而非减法：否定是对整体意愿的「折扣」，
 * 减法会让「只写了 1 篇且删掉」的用户得到负分并被 clamp 成 0，
 * 与「写了 20 篇全删」的用户无法区分；乘法保留了强度差异。
 */
export function computePublicationIntent(input: IntentInput): PublicationIntentReport {
  const { projects, now } = input
  if (!Array.isArray(projects) || projects.length === 0) return EMPTY_REPORT

  const ladders = projects.map(ladderOf)
  const total = projects.length

  const published = ladders.filter((l) => l.rank >= LADDER_RANK.published).length
  const finalized = ladders.filter((l) => l.rank >= LADDER_RANK.finalized).length
  const approved = ladders.filter((l) => l.rank >= LADDER_RANK.approved).length
  const polishing = ladders.filter((l) => l.rank === LADDER_RANK.polishing).length
  const negative = projects.filter((p) => p.negative).length

  const publishRate = published / total
  const finalizeRate = finalized / total
  const approvalRate = approved / total
  const negativeRate = negative / total

  const raw =
    SCORE_WEIGHTS.publish * publishRate +
    SCORE_WEIGHTS.finalize * finalizeRate +
    SCORE_WEIGHTS.approval * approvalRate
  const intentScore = round3(raw * (1 - NEGATIVE_DISCOUNT * negativeRate))

  let peakLevel: PublicationLadder = 'unclaimed'
  for (const l of ladders) {
    if (l.rank > LADDER_RANK[peakLevel]) peakLevel = l.level
  }

  return {
    peakLevel,
    counts: { total, polishing, approved: approved, finalized, published, negative },
    rates: {
      publish: round3(publishRate),
      finalize: round3(finalizeRate),
      approval: round3(approvalRate),
      negative: round3(negativeRate),
    },
    intentScore,
    confidence: intentConfidence(projects, now),
    ladders,
  }
}

// ─────────────────────────── 取数（IO，与上面纯函数分开）───────────────────────────

type SupabaseServerClient = ReturnType<typeof createServerClient>

/**
 * 从库里拼出行为事实包。
 *
 * 任一查询失败都降级为「该维度缺失」而非整体失败：
 * 指标是观测工具，绝不能因为它挂掉而阻断任何用户可见的功能。
 *
 * finalized 取 creative_projects.status（权威），不取 work_finalize 事件 ——
 * 事件流里定稿后取消定稿要靠新事件表达，而 status 始终是唯一真相。
 */
export async function fetchIntentFacts(
  supabase: SupabaseServerClient,
  userId: string
): Promise<ProjectIntentFacts[]> {
  const nowIso = new Date().toISOString()

  // 1. 项目（分母）
  const { data: projectRows, error: projErr } = await supabase
    .from('creative_projects')
    .select('id, status, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(MAX_PROJECTS)

  if (projErr) {
    console.error('[intent] 拉取项目失败:', projErr.message)
    return []
  }
  if (!projectRows || projectRows.length === 0) return []

  const facts = new Map<string, ProjectIntentFacts>()
  for (const row of projectRows as Array<{ id: string; status?: string; updated_at?: string }>) {
    facts.set(row.id, {
      projectId: row.id,
      edited: false,
      liked: false,
      negative: false,
      finalized: row.status === 'finalized',
      published: false,
      lastActivityAt: row.updated_at ?? nowIso,
    })
  }

  // 2. 事件（edited / liked / negative / 活跃时间）
  const { data: eventRows, error: evErr } = await supabase
    .from('creator_events')
    .select('event_type, project_id, occurred_at')
    .eq('user_id', userId)
    .order('occurred_at', { ascending: false })
    .limit(MAX_EVENTS)

  if (evErr) {
    console.error('[intent] 拉取事件失败（迭代/认可维度将缺失）:', evErr.message)
  } else if (Array.isArray(eventRows)) {
    for (const row of eventRows as Array<{
      event_type?: string
      project_id?: string | null
      occurred_at?: string
    }>) {
      const pid = row.project_id
      if (!pid) continue // 无项目的老作品不进分母（需先 adopt）
      const f = facts.get(pid)
      if (!f) continue
      switch (row.event_type) {
        case 'work_edit':
        case 'work_regenerate':
          f.edited = true
          break
        case 'feedback_like':
          f.liked = true
          break
        case 'feedback_dislike':
        case 'work_delete':
          f.negative = true
          break
        default:
          break
      }
      // 事件是最新的行为证据，比项目 updated_at 更贴近「最近一次动了它」
      if (row.occurred_at) f.lastActivityAt = row.occurred_at
    }
  }

  // 3. 发布（最稀缺也最强的事实）
  //
  // 关键：帖子独立于项目存活。项目被删后 source_project_id 变成「孤儿」，
  // 但那一次发布意愿真实发生过 —— 帖子仍公开在广场，archive 快照也在。
  // 早期实现里 `if (f) f.published = true` 会静默丢弃孤儿证据，
  // 导致「发布过作品、之后清理了项目」的用户被算成从未发布过（publishRate 恒 0）。
  // 修法：孤儿项目补建最小事实包，分子分母各 +1，等价于「它存在过，且发布过」。
  const { data: postRows, error: postErr } = await supabase
    .from('posts')
    .select('source_project_id, created_at')
    .eq('user_id', userId)
    .not('source_project_id', 'is', null)
    .limit(MAX_PROJECTS)

  if (postErr) {
    console.error('[intent] 拉取发布记录失败（发布维度将缺失）:', postErr.message)
  } else if (Array.isArray(postRows)) {
    for (const row of postRows as Array<{
      source_project_id?: string | null
      created_at?: string
    }>) {
      const pid = row.source_project_id
      if (!pid) continue
      const f = facts.get(pid)
      if (f) {
        f.published = true
        continue
      }
      // 孤儿：项目已不在项目表（多为被删），补建事实包以免抹掉这次发布
      if (facts.size >= MAX_PROJECTS) continue // 与项目取数同上限，防异常账号放大
      facts.set(pid, {
        projectId: pid,
        edited: false,
        liked: false,
        negative: false,
        // 项目已消失，无从得知当时是否定稿；保守按未定稿（发布不强制定稿）
        finalized: false,
        published: true,
        lastActivityAt: row.created_at ?? nowIso,
      })
    }
  }

  return [...facts.values()]
}
