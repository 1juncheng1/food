// ============================================================
// WF6：AI 推荐理由预制（build 步骤 14.5，请求路径零 LLM）
//
// 流程：算法筛选出 Top N 高匹配候选后，一次 DeepSeek 批量调用为每条生成
//   { coreQuestion, whyRecommend, creationAngle, relatedKnowledge }
// AI 只做"解释"，不做"筛选"——输入是已打分的候选 + evidence 事实包，
// 输出必须通过事实校验（whyRecommend 复述 cluster_label、
// relatedKnowledge 闭集选自 S3 素材标题），不合规逐条降级模板。
//
// 红线：AI 失败/超时/幻觉绝不丢卡——降级模板照常落库（reason_source=template）。
// ============================================================

export interface AiReasonInput {
  title: string
  /** 所配簇 label；null = 无匹配簇（探索卡等），直接模板不送 AI */
  clusterLabel: string | null
  /** evidence.facts 事实数组（create/finalize/save 计数） */
  facts: Array<Record<string, unknown>>
  /** evidence.gap_reason */
  gapReason: string | null
  /** S3 收藏素材标题闭集（relatedKnowledge 的合法取值域） */
  materialTitles: string[]
}

export interface AiReasonOutput {
  coreQuestion: string | null
  whyRecommend: string | null
  creationAngle: string | null
  relatedKnowledge: string[]
  reasonSource: 'ai' | 'template'
}

const SYSTEM_PROMPT = [
  '你是创作者推荐系统的解释器。给你若干条已筛选出的推荐选题，以及每个选题背后的真实用户行为事实。',
  '为每条生成个性化的推荐解释。硬性要求：',
  '1. why_recommend 必须基于给定事实复述（必须包含该条的方向名称），禁止编造用户没有的行为',
  '2. related_knowledge 只能从给定的素材标题列表中选（没有合适的就留空数组），禁止编造素材',
  '3. core_question：这个选题要回答的核心问题，一句话',
  '4. creation_angle：给这位创作者的具体切入建议，结合他的行为特征',
  '5. 语言自然口语化，像懂用户的创作助手，不要营销腔',
  '',
  '输出 JSON 对象 {"reasons": [...]}，reasons 数组顺序与输入一致，每元素含：',
  'core_question / why_recommend / creation_angle / related_knowledge（字符串数组）',
  '只输出 JSON，不要 markdown 代码块或解释。',
].join('\n')

const EMPTY_TEMPLATE: AiReasonOutput = {
  coreQuestion: null,
  whyRecommend: null,
  creationAngle: null,
  relatedKnowledge: [],
  reasonSource: 'template',
}

function templateOutput(input: AiReasonInput): AiReasonOutput {
  return { ...EMPTY_TEMPLATE, whyRecommend: buildReasonTextFromAiInput(input) }
}

/** 无 facts 候选的模板文案（探索卡等） */
function buildReasonTextFromAiInput(input: AiReasonInput): string | null {
  if (!input.clusterLabel && !input.gapReason) return null
  return input.gapReason ?? '基于你的创作兴趣推荐'
}

interface LlmReasonItem {
  core_question?: unknown
  why_recommend?: unknown
  creation_angle?: unknown
  related_knowledge?: unknown
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().slice(0, max)
  return s || null
}

/**
 * 批量生成推荐理由。
 * @param items 候选列表（≤20；调用方保证已按分排序，WF11 P1 起由 6 扩到 20）
 * @returns 与 items 等长的输出数组，逐条 ai/template 标注，永不抛错
 */
export async function generateAiReasons(items: AiReasonInput[]): Promise<AiReasonOutput[]> {
  // 事实红线：只有带真实行为事实（facts 非空）的候选才送 AI——
  // 探索卡/无簇卡没有可复述的事实，让 LLM 自由发挥必然编造，直接模板
  const out: AiReasonOutput[] = items.map((it) =>
    it.facts.length ? { ...EMPTY_TEMPLATE } : templateOutput(it)
  )
  const eligibleIdx = items.reduce<number[]>((acc, it, i) => {
    if (it.facts.length) acc.push(i)
    return acc
  }, [])
  if (!eligibleIdx.length) return out

  if (!process.env.DEEPSEEK_API_KEY) {
    // 未配置 LLM：全部模板（与 S4 exploration 同口径）
    return out
  }

  const materialPool = [...new Set(items.flatMap((it) => it.materialTitles))].slice(0, 20)

  const itemsText = eligibleIdx
    .map((i, seq) => {
      const it = items[i]
      const factsText = it.facts
        .map((f) => {
          const type =
            f.type === 'create' ? '生成' : f.type === 'finalize' ? '定稿' : f.type === 'save' ? '收藏' : String(f.type)
          return `${type} ${f.count ?? 0} 篇`
        })
        .join('，')
      const gap = it.gapReason ? `；缺口：${it.gapReason}` : ''
      return `[${seq + 1}] 选题：《${it.title}》 方向：${it.clusterLabel ?? '探索'}。用户真实行为：${
        factsText || '暂无直接行为'
      }${gap}`
    })
    .join('\n')

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              `可选素材（related_knowledge 只能从这里选）：${materialPool.length ? materialPool.join('；') : '（无）'}`,
              '',
              itemsText,
            ].join('\n'),
          },
        ],
        temperature: 0.7,
        // token 预算口径 = 每条理由约 230 token（旧 6 条/1400 的实测均值）+ 200 结构余量。
        // WF11 P1：理由覆盖扩到 20 条（≈4800 token），预算不跟着涨会 JSON 截断，
        // 后半批量在解析处静默降级为模板（表面不报错但理由质量塌方）。
        max_tokens: 200 + eligibleIdx.length * 230,
        response_format: { type: 'json_object' },
      }),
    })
    if (!res.ok) {
      console.error('[interest] AI 理由生成 HTTP 失败:', res.status)
      return out
    }

    const data = await res.json()
    const text: string = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) return out

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const parsed: unknown = JSON.parse(cleaned)
    const arr: LlmReasonItem[] = Array.isArray(parsed)
      ? (parsed as LlmReasonItem[])
      : Array.isArray((parsed as Record<string, unknown>)?.reasons)
        ? ((parsed as Record<string, unknown>).reasons as LlmReasonItem[])
        : []
    if (!arr.length) return out

    for (let seq = 0; seq < eligibleIdx.length; seq++) {
      const idx = eligibleIdx[seq]
      const it = items[idx]
      const r = arr[seq]
      if (!r) break // AI 条数不足：剩余保持模板

      const why = str(r.why_recommend, 120)
      const clusterLabel = it.clusterLabel
      // 事实校验：必须复述方向名（无簇候选已不送 AI，此处 label 恒存在）
      if (!why || !clusterLabel || !why.includes(clusterLabel)) continue

      // relatedKnowledge 闭集过滤（AI 编造的素材直接剔除）
      const rawRel = Array.isArray(r.related_knowledge) ? r.related_knowledge : []
      const related = rawRel
        .filter((x): x is string => typeof x === 'string')
        .filter((x) => materialPool.includes(x))
        .slice(0, 3)

      out[idx] = {
        coreQuestion: str(r.core_question, 80),
        whyRecommend: why,
        creationAngle: str(r.creation_angle, 120),
        relatedKnowledge: related,
        reasonSource: 'ai',
      }
    }
    return out
  } catch (e) {
    console.error('[interest] AI 理由生成异常（全部模板降级）:', e instanceof Error ? e.message : e)
    return out
  }
}

// ──────────────────────────────────────────────────────────
// 模板理由（从 /api/inspirations route.ts 迁出，route 改为复用）
// ──────────────────────────────────────────────────────────

/** 从 evidence 事实包生成中文解释（与旧 route 版行为逐字一致） */
export function buildReasonText(s: {
  slot: string
  clusterCode: string | null
  evidence: Record<string, unknown>
}): string {
  const facts = s.evidence?.facts as Array<Record<string, unknown>> | undefined
  if (!facts?.length) return '基于你的创作兴趣推荐'

  const parts: string[] = []
  const clusterLabel = (facts[0]?.cluster_label as string) ?? '该方向'
  const createCount = facts.find((f) => f.type === 'create')?.count as number | undefined
  const finalizeCount = facts.find((f) => f.type === 'finalize')?.count as number | undefined
  const saveCount = facts.find((f) => f.type === 'save')?.count as number | undefined

  if (createCount) parts.push(`最近 30 天生成 ${createCount} 篇「${clusterLabel}」相关内容`)
  if (finalizeCount) parts.push(`定稿 ${finalizeCount} 篇`)
  if (saveCount) parts.push(`收藏 ${saveCount} 条相关案例`)

  const gapReason = s.evidence?.gap_reason as string | undefined
  if (gapReason) parts.push(gapReason)

  return parts.length ? parts.join('，') : '基于你的创作兴趣推荐'
}
