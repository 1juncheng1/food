import { NextResponse } from 'next/server'
import { authFailureResponse } from '@/lib/apiAuth'
import { createServerClient } from '@/lib/supabaseServer'
import { generateEmbedding } from '@/lib/storage'
import { averageVectors, parseVector, updateUserStyleVector } from '@/lib/styleVector'
import { computeBasicStats } from '@/lib/creative/languageStats'
import { parseEditingProfile } from '@/lib/creative/editingMemory'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

/** 风格卡字段结构 */
interface StyleProfile {
  tone_tags: string[]
  pace_preference: string
  common_opening: string
  avg_length: number
  source: string
  style_vector?: number[] | string | null
  // ── Creator Model（个人创作者模型，9.5 节）──
  creator_personality?: string | null
  topic_preferences?: string[]
  favorite_elements?: string[]
  avoid_elements?: string[]
  ai_creator_summary?: string | null
  model_meta?: Record<string, unknown>
}

/** POST 请求体 */
interface UpdateBody {
  toneTags?: unknown
  pacePreference?: unknown
  commonOpening?: unknown
  avgLength?: unknown
  // Creator Model 声明类字段（用户手动编辑）
  creatorPersonality?: unknown
  topicPreferences?: unknown
  favoriteElements?: unknown
  avoidElements?: unknown
  // 风格向量更新模式：传入文本，服务端计算 embedding 后更新
  updateVectorFromText?: unknown
  // 模式 C：重新从全部历史内容确定性统计语言特征（不调 AI，不碰 Creator 声明/五维画像）
  recompute?: unknown
}

/** 安全取字符串并截断长度 */
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** 安全取字符串数组：过滤非字符串元素并截断每项长度 */
function strArr(v: unknown, maxLen: number, maxCount: number): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim().slice(0, maxLen))
    .slice(0, maxCount)
}

/**
 * 从 Authorization 头提取 Bearer token，验证用户身份。
 * 项目 session 存 localStorage，前端需显式把 access_token 传上来。
 * export 供同目录 summarize 子路由复用，避免鉴权逻辑分叉。
 */
export async function authenticateStyleProfile(req: Request) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) return null

  const supabase = createServerClient(token)
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token)
  if (error || !user) return null

  return { supabase, userId: user.id }
}

// ────────────────────────────────────────────────────────────
// 确定性语言特征统计（语气/节奏/开头/均长）统一在
// lib/creative/languageStats.ts，保证风格卡与 DNA 报告口径一致。
// ────────────────────────────────────────────────────────────

/**
 * 加载用户全部历史内容与 embedding：
 * 数据源 A=scripts.content（素材库，近 200），B=generation_history.sample_text（作品，近 200）。
 * GET 首次建卡与 POST recompute 共用，保证两处统计口径永远一致。
 */
async function loadHistoryContents(
  supabase: ReturnType<typeof createServerClient>,
  userId: string
): Promise<{ allContents: string[]; allEmbeddings: number[][] }> {
  const [{ data: scripts, error: scriptErr }, { data: history, error: histErr }] =
    await Promise.all([
      supabase
        .from('scripts')
        .select('content, embedding')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('generation_history')
        .select('sample_text, embedding')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(200),
    ])

  if (scriptErr) console.error('查询 scripts 失败:', scriptErr)
  if (histErr) console.error('查询 generation_history 失败:', histErr)

  const allContents: string[] = []
  const allEmbeddings: number[][] = []
  for (const s of scripts ?? []) {
    if (s?.content) allContents.push(s.content)
    const emb = parseVector(s?.embedding)
    if (emb) allEmbeddings.push(emb)
  }
  for (const h of history ?? []) {
    if (h?.sample_text) allContents.push(h.sample_text)
    const emb = parseVector(h?.embedding)
    if (emb) allEmbeddings.push(emb)
  }
  return { allContents, allEmbeddings }
}

// ── GET：获取当前用户的风格卡，不存在则自动统计并插入 ──
export async function GET(req: Request) {
  try {
    const auth = await authenticateStyleProfile(req)
    if (!auth) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const { supabase, userId } = auth

    // 1) 先查 style_profiles 是否已有记录
    const { data: existing, error: selErr } = await supabase
      .from('style_profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (selErr) {
      console.error('查询风格卡失败:', selErr)
      // 服务端日志保留细节；数据库报错可能含表名/策略名，不能回显给客户端
      return NextResponse.json({ error: '查询风格卡失败' }, { status: 500 })
    }

    // 2) 已有记录直接返回
    if (existing) {
      return NextResponse.json({ profile: existing })
    }

    // 3) 无记录：从用户历史内容统计初始值（素材库 + AI 作品，与 recompute 同口径）
    const { allContents, allEmbeddings } = await loadHistoryContents(supabase, userId)

    const computed = computeBasicStats(allContents)

    // style_vector = 所有历史内容 embedding 的逐维平均值
    // 口径：scripts.embedding + generation_history.embedding 合并后逐维求平均
    const styleVector = averageVectors(allEmbeddings)

    // 4) 插入统计结果（upsert 防并发写入冲突）
    const { data: inserted, error: insErr } = await supabase
      .from('style_profiles')
      .upsert(
        {
          user_id: userId,
          tone_tags: computed.tone_tags,
          pace_preference: computed.pace_preference,
          common_opening: computed.common_opening,
          avg_length: computed.avg_length,
          source: 'auto',
          style_vector: styleVector,
        },
        { onConflict: 'user_id' }
      )
      .select()
      .maybeSingle()

    if (insErr) {
      console.error('插入风格卡失败:', insErr)
      // 服务端日志保留细节；数据库报错可能含表名/策略名，不能回显给客户端
      return NextResponse.json({ error: '保存风格卡失败' }, { status: 500 })
    }

    return NextResponse.json({ profile: inserted })
  } catch (error) {
    console.error('style-profile GET 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

// ── POST：手动编辑风格卡 ──
export async function POST(req: Request) {
  try {
    const auth = await authenticateStyleProfile(req)
    if (!auth) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const { supabase, userId } = auth

    const body = (await req.json()) as UpdateBody

    // ── 模式 C：重新统计（确定性计算，不调 AI）──
    // 只覆盖语言事实列（语气/节奏/开头/均长/向量/source）；
    // creator_personality/topic/favorite/avoid（用户声明）、ai_creator_summary、
    // style_dimensions（五维学习）一律不碰。
    if (body.recompute === true) {
      const { allContents, allEmbeddings } = await loadHistoryContents(supabase, userId)
      const computed = computeBasicStats(allContents)
      const styleVector = averageVectors(allEmbeddings)

      const { data: recomputed, error: rcErr } = await supabase
        .from('style_profiles')
        .upsert(
          {
            user_id: userId,
            tone_tags: computed.tone_tags,
            pace_preference: computed.pace_preference,
            common_opening: computed.common_opening,
            avg_length: computed.avg_length,
            source: 'auto',
            style_vector: styleVector,
          },
          { onConflict: 'user_id' }
        )
        .select()
        .maybeSingle()

      if (rcErr) {
        console.error('重新统计风格卡失败:', rcErr)
        // 服务端日志保留细节；数据库报错可能含表名/策略名，不能回显给客户端
        return NextResponse.json({ error: '重新统计失败' }, { status: 500 })
      }

      return NextResponse.json({ profile: recomputed, recomputed: true, sampleCount: allContents.length })
    }

    // ── 模式 A：风格向量更新（传入文本，服务端计算 embedding 并加权平均）──
    const textForVector = str(body.updateVectorFromText, 10000)
    if (textForVector) {
      // 计算文本 embedding
      const newVector = await generateEmbedding(textForVector)
      if (!newVector) {
        return NextResponse.json({ error: '向量化失败，请稍后重试' }, { status: 500 })
      }
      // 加权平均更新 style_profiles.style_vector
      // 公式：new = 0.8 * old + 0.2 * input
      await updateUserStyleVector(supabase, userId, newVector)
      return NextResponse.json({ success: true, updated: 'style_vector' })
    }

    // ── 模式 B：手动编辑风格卡字段 ──
    // 校验并提取字段
    const toneTags = strArr(body.toneTags, 20, 20)
    const pacePreference = str(body.pacePreference, 20)
    const commonOpening = str(body.commonOpening, 20)
    const avgLengthNum = Number(body.avgLength)
    // 平均字符数：非负整数，非法值降级为 0
    const avgLength =
      Number.isFinite(avgLengthNum) && avgLengthNum >= 0
        ? Math.min(Math.floor(avgLengthNum), 100000)
        : 0

    // 节奏偏好枚举校验
    const validPace = ['快节奏', '慢节奏', '中等', '未知']
    if (pacePreference && !validPace.includes(pacePreference)) {
      return NextResponse.json({ error: '无效的节奏偏好值' }, { status: 400 })
    }

    // ── Creator Model 声明类字段（人格名 / 题材偏好 / 喜欢元素 / 排斥元素）──
    const creatorPersonality = str(body.creatorPersonality, 60)
    const topicPreferences = strArr(body.topicPreferences, 30, 15)
    const favoriteElements = strArr(body.favoriteElements, 30, 15)
    const avoidElements = strArr(body.avoidElements, 30, 15)

    // upsert：有记录则更新，无则插入。
    // 注意：ai_creator_summary / style_dimensions / style_vector 不在此写入，
    // 分别由 summarize API 与学习链路维护，避免手动保存覆盖它们。
    const { data, error } = await supabase
      .from('style_profiles')
      .upsert(
        {
          user_id: userId,
          tone_tags: toneTags.length > 0 ? toneTags : [],
          pace_preference: pacePreference || '未知',
          common_opening: commonOpening || '未知',
          avg_length: avgLength,
          source: 'manual',
          creator_personality: creatorPersonality || null,
          topic_preferences: topicPreferences,
          favorite_elements: favoriteElements,
          avoid_elements: avoidElements,
        },
        { onConflict: 'user_id' }
      )
      .select()
      .maybeSingle()

    if (error) {
      console.error('更新风格卡失败:', error)
      // 服务端日志保留细节；数据库报错可能含表名/策略名，不能回显给客户端
      return NextResponse.json({ error: '更新风格卡失败' }, { status: 500 })
    }

    return NextResponse.json({ profile: data })
  } catch (error) {
    console.error('style-profile POST 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}

/**
 * PATCH /api/style-profile
 * AI 协作修改（P5）：从编辑偏好记忆中移除单条偏好（用户对 AI 的推断有最终否决权）。
 * 输入：{ removePreference: { type: 'like'|'avoid', statement: string } }
 * 幂等：目标不存在时返回成功（前端按"已移除"处理即可）。
 */
export async function PATCH(req: Request) {
  try {
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const supabase = createServerClient(token)
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token)
    if (authErr || !user) {
      return authFailureResponse(authErr)
    }

    const body = (await req.json().catch(() => ({}))) as {
      removePreference?: { type?: unknown; statement?: unknown }
    }
    const type = body.removePreference?.type === 'avoid' ? 'avoid' : body.removePreference?.type === 'like' ? 'like' : null
    const statement =
      typeof body.removePreference?.statement === 'string'
        ? body.removePreference.statement.trim().slice(0, 50)
        : ''
    if (!type || !statement) {
      return NextResponse.json({ error: '缺少偏好标识' }, { status: 400 })
    }

    // 读当前画像 → 过滤掉目标条 → 写回（空画像时写结构化空对象，保持列语义）
    const { data: row } = await supabase
      .from('style_profiles')
      .select('editing_profile')
      .eq('user_id', user.id)
      .maybeSingle()

    const state = parseEditingProfile(row?.editing_profile)
    const before = state.preferences.length
    state.preferences = state.preferences.filter(
      (p) => !(p.type === type && p.statement === statement)
    )
    const changed = state.preferences.length !== before

    const { error: updErr } = await supabase
      .from('style_profiles')
      .upsert(
        { user_id: user.id, editing_profile: state },
        { onConflict: 'user_id' }
      )
    if (updErr) {
      console.error('移除编辑偏好失败:', updErr)
      return NextResponse.json({ error: '移除失败，请稍后重试' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, removed: changed })
  } catch (error) {
    console.error('style-profile PATCH 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
