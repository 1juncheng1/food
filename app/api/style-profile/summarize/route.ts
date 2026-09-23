import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { rateLimit } from '@/lib/rateLimit'
import { parseStyleDimensions } from '@/lib/creative/styleLearning'
import { callDeepSeekChat } from '@/lib/llm'
import {
  assembleCreatorReport,
  buildStatsBrief,
  parseCreatorReport,
  parseLlmDraft,
  type CreatorReport,
  type ReportInput,
} from '@/lib/creative/creatorReport'
import { authenticateStyleProfile } from '../route'

export const maxDuration = 45
export const dynamic = 'force-dynamic'

// ────────────────────────────────────────────────────────────
// POST /api/style-profile/summarize
// 「AI 重新理解我」：确定性统计包 + AI 归纳 → 版本化创作 DNA 报告。
//
// 边界（产品原则）：
// 1. 只能手动触发：页面加载永不调用本接口；报告缓存于 style_profiles.creator_report；
// 2. 并发去重：同一用户的在途请求共享同一个 Promise，双击/多标签只烧一次 LLM；
// 3. 昂贵校验（迁移列/样本数）在调 LLM 之前完成；
// 4. AI 只负责命名与定性标签，所有百分比由服务端按真实引用计数重算；
// 5. 用户声明（人格名/喜欢/排斥）不被覆盖，bounds 只镜像声明列。
// ────────────────────────────────────────────────────────────

type ErrCode =
  | 'unauthenticated'
  | 'insufficient_samples'
  | 'rate_limited'
  | 'migration_required'
  | 'llm_failed'
  | 'bad_llm_response'
  | 'save_failed'

interface SummarizeResult {
  status: number
  body:
    | { success: true; report: CreatorReport; summary: string; suggestedPersonality: string }
    | { success: false; error: string; code: ErrCode; retryAfter?: number }
}

function err(status: number, code: ErrCode, error: string, retryAfter?: number): SummarizeResult {
  return { status, body: { success: false, code, error, ...(retryAfter ? { retryAfter } : {}) } }
}

/** 在途请求表：同用户并发请求折叠为同一个 LLM 调用 */
const inflight = new Map<string, Promise<SummarizeResult>>()

async function runSummarize(
  userId: string,
  supabase: ReturnType<typeof createServerClient>
): Promise<SummarizeResult> {
  // 限流：每用户 10 分钟最多 3 次（在途折叠之后，双击不额外消耗配额）
  const rl = rateLimit(`style-profile-summarize:${userId}`, 3, 10 * 60_000)
  if (!rl.ok) {
    return err(429, 'rate_limited', '刷新过于频繁，请稍后再让 AI 重新理解你', rl.retryAfterSec)
  }

  // ── 1. 读现有风格卡（同时充当"9.6 迁移列是否存在"的探针：列缺失在此就报错，不调 LLM）──
  const profileColumns =
    'tone_tags, pace_preference, common_opening, avg_length, style_dimensions, creator_personality, topic_preferences, favorite_elements, avoid_elements, ai_creator_summary, creator_report'
  const { data: profile, error: profErr } = await supabase
    .from('style_profiles')
    .select(profileColumns)
    .eq('user_id', userId)
    .maybeSingle()

  if (profErr) {
    if (profErr.code === '42703' || /column .* does not exist/i.test(profErr.message)) {
      return err(
        500,
        'migration_required',
        '数据库缺少创作者 DNA 字段，请先执行 setup.sql 9.6 节迁移后再试'
      )
    }
    console.error('summarize 读风格卡失败:', profErr)
    return err(500, 'save_failed', '读取风格数据失败，请稍后重试')
  }

  // ── 2. 读近期作品（近 10 篇）与素材库（近 20 条）──
  const { data: works, error: worksErr } = await supabase
    .from('generation_history')
    .select('topic, category, sample_text, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10)
  if (worksErr) console.error('summarize 读作品失败:', worksErr)

  const { data: materials, error: matErr } = await supabase
    .from('scripts')
    .select('category, content, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20)
  if (matErr) console.error('summarize 读素材失败:', matErr)

  const workList = works ?? []
  const materialList = materials ?? []
  if (workList.length + materialList.length < 2) {
    return err(
      409,
      'insufficient_samples',
      '样本还太少——先创作或保存 2 篇以上内容，AI 才能准确理解你'
    )
  }

  // ── 3. 组装确定性输入（五维信号数 + 用户声明边界 + 旧报告版本）──
  const p: {
    style_dimensions?: unknown
    favorite_elements?: unknown
    avoid_elements?: unknown
    creator_report?: unknown
  } = profile ?? {}
  const dims = parseStyleDimensions(p.style_dimensions)
  const toStringArr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : []

  const input: ReportInput = {
    works: workList.map((w) => ({
      topic: typeof w.topic === 'string' ? w.topic : '',
      category: typeof w.category === 'string' ? w.category : '',
      sample_text: typeof w.sample_text === 'string' ? w.sample_text : '',
    })),
    materials: materialList.map((m) => ({
      category: typeof m.category === 'string' ? m.category : '',
      content: typeof m.content === 'string' ? m.content : '',
    })),
    signals: dims.samples,
    declared: {
      favorite: toStringArr(p.favorite_elements),
      avoid: toStringArr(p.avoid_elements),
    },
    previous: parseCreatorReport(p.creator_report),
  }
  const { brief } = buildStatsBrief(input)

  // ── 4. 调 DeepSeek：AI 只命名/定性/选证据，数字由服务端重算 ──
  const llmRes = await callDeepSeekChat({
    temperature: 0.5,
    max_tokens: 1200,
    jsonMode: true,
    messages: [
      {
        role: 'system',
        content: `你是一位创作者画像分析师。根据下面的客观创作数据，分析这个创作者的「创作 DNA」。
输出 JSON（不要 markdown、不要多余文字）：
{
  "main": "主人格名，4-8字，如 冷峻解构者",
  "sub": "副人格名，4-8字，体现他创作中的另一面；没有把握给空字符串",
  "description": "120-200字，第二人称，先说持续关注的母题与情绪，再说语言与叙事特征；具体、有辨识度，禁止'内容丰富结构清晰'类空话",
  "motifs": [{"label":"母题词，2-6字如 人性/科技/时代","refs":["引用能支撑该母题的作品主题原文，逐字摘自清单，2-5条"]}],
  "narratives": [{"label":"叙事特征词，2-8字如 人物心理切入/细节拆解","refs":["引用相关作品的主题原文，2-5条"]}],
  "language": ["语言风格词2-4字，如 冷静/克制/高密度", "共3-5个"]
}
硬性要求：
1. 只基于给定数据，严禁编造职业、身份、经历；特征不明显就少给标签，不要硬凑；
2. motifs 最多 4 个、narratives 最多 4 个，按显著程度排序；
3. refs 必须逐字引用清单里的「主题：xxx」原文（去掉"主题："前缀），禁止自己编造主题；
4. motifs 是内容母题（讲什么），narratives 是讲述方式（怎么讲），不要混淆；
5. language 只给定性形容词，不要百分比、不要短句；
6. 用户声明的喜欢/排斥必须体现在 description 的语言判断中，但不要原样照念。`,
      },
      { role: 'user', content: brief },
    ],
  })

  if (!llmRes.ok) {
    console.error('creator report LLM 失败:', llmRes.error)
    return err(500, 'llm_failed', 'AI 分析生成失败，请稍后重试')
  }

  const raw: string = llmRes.content
  const draft = parseLlmDraft(raw)
  if (!draft) {
    console.warn('creator report JSON 异常，原始内容:', raw.slice(0, 300))
    return err(502, 'bad_llm_response', 'AI 返回内容异常，请再试一次')
  }

  // ── 5. 确定性骨架 + 证据校验 + 权重重算，组装版本化报告 ──
  const report = assembleCreatorReport(input, draft)

  // 人格名/母题/叙事三类全空才视为彻底失败（至少要有 AI 对人的命名与描述——draft 已保证）
  const modelMeta = {
    summaryUpdatedAt: report.updatedAt,
    workSampleCount: report.sources.works,
    materialSampleCount: report.sources.materials,
    signalCount: report.sources.signals,
    reportVersion: report.version,
  }

  // ── 6. 写库：creator_report（新）+ ai_creator_summary（旧读者回退）+ model_meta ──
  const { error: upErr } = await supabase
    .from('style_profiles')
    .upsert(
      {
        user_id: userId,
        creator_report: report,
        // 同步旧总结列：旧版本页面/无报告回退路径仍有内容可读
        ai_creator_summary: report.personality.description,
        model_meta: modelMeta,
      },
      { onConflict: 'user_id' }
    )

  if (upErr) {
    console.error('写 creator_report 失败:', upErr)
    return err(
      500,
      'save_failed',
      upErr.code === '42703'
        ? '数据库缺少创作者 DNA 字段，请先执行 setup.sql 9.6 节迁移后再试'
        : '分析已生成但保存失败，请稍后重试'
    )
  }

  return {
    status: 200,
    body: {
      success: true,
      report,
      summary: report.personality.description,
      suggestedPersonality: report.personality.main,
    },
  }
}

export async function POST(req: Request) {
  try {
    const auth = await authenticateStyleProfile(req)
    if (!auth) {
      return NextResponse.json(
        { success: false, code: 'unauthenticated', error: '请先登录' },
        { status: 401 }
      )
    }
    const { userId, supabase } = auth

    // 并发折叠：同用户在途请求复用同一个 Promise
    let job = inflight.get(userId)
    if (!job) {
      job = runSummarize(userId, supabase).finally(() => {
        inflight.delete(userId)
      })
      inflight.set(userId, job)
    }

    const result = await job
    return NextResponse.json(result.body, { status: result.status })
  } catch (e) {
    console.error('style-profile summarize 错误:', e)
    return NextResponse.json(
      { success: false, code: 'llm_failed', error: '服务器内部错误' },
      { status: 500 }
    )
  }
}
