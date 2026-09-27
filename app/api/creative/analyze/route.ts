import { NextResponse } from 'next/server'
import { authFailureResponse } from '@/lib/apiAuth'
import { guardRateLimit } from '@/lib/rateLimit'
import { isLlmNetworkError, llmUserMessage } from '@/lib/llm'
import { createServerClient } from '@/lib/supabaseServer'
import {
  blueprintFromRaw,
  generateDiagnosis,
  parseDiagnosis,
  type CreativeDiagnosis,
} from '@/lib/creative/diagnosis'
import { fetchCreatorStyleProfile } from '@/lib/creative/styleProfileRepo'
import { normalizeCreatorDeclaration } from '@/lib/creative/creatorDeclaration'
import { normalizeInterestProfile } from '@/lib/creative/interest/promptBlock'
import { parseEditingProfile } from '@/lib/creative/editingMemory'
import { checkConsistency, type ConsistencyCheck } from '@/lib/creative/consistencyCheck'
import { INSUFFICIENT_POINTS_MESSAGE } from '@/lib/balance'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

interface RequestBody {
  generationId?: unknown // generation_history 行 id（项目版本为 pid::vN，老作品为前端 uuid）
  force?: unknown // true = 忽略已有诊断重新分析
}

function str(v: unknown, maxLen: number): string {
  return typeof v === 'string' ? v.trim().slice(0, maxLen) : ''
}

/**
 * 创作一致性三问的输入装配（纯读取，失败一律降级为 null）。
 *
 * 一致性是"增强项"：缺任何一路数据都只是少一条结论，绝不能让诊断失败。
 * creator_knowledge 未迁移时查库会报错，这里按"没有知识单元"处理。
 */
async function buildConsistency(
  supabase: ReturnType<typeof createServerClient>,
  userId: string,
  text: string,
  topic: string
): Promise<ConsistencyCheck | null> {
  try {
    // 画像列统一走 styleProfileRepo（缺失列自动降级，未迁移环境不报错）
    const [profile, knowledgeRes] = await Promise.all([
      fetchCreatorStyleProfile(supabase, userId),
      supabase
        .from('creator_knowledge')
        .select('concept, domain_scope')
        .eq('user_id', userId)
        .eq('status', '已确认')
        .limit(50),
    ])

    // 硬禁忌：用户声明的排斥内容 + 高置信拒绝过的改法（与生成链路同口径）
    const declaration = normalizeCreatorDeclaration(
      (profile as Record<string, unknown> | null)?.creator_declaration
    )
    const editing = parseEditingProfile(profile?.editing_profile)
    const hardAvoids: string[] = []
    if (declaration.avoid_preference) hardAvoids.push(declaration.avoid_preference)
    for (const p of editing.preferences) {
      if (p.type === 'avoid' && p.sourceCount >= 2) hardAvoids.push(p.statement)
    }

    const interest = normalizeInterestProfile(profile?.interest_profile)

    return checkConsistency({
      text,
      topic,
      knowledge: (knowledgeRes.data ?? []).map((k: { concept?: string; domain_scope?: unknown }) => ({
        concept: typeof k.concept === 'string' ? k.concept : '',
        domainScope: Array.isArray(k.domain_scope)
          ? k.domain_scope.filter((x): x is string => typeof x === 'string')
          : [],
      })),
      interestTopics: interest?.topicInterest.map((t) => t.name) ?? [],
      hardAvoids,
    })
  } catch (e) {
    console.error('一致性三问计算失败（不影响诊断）:', e)
    return null
  }
}

/**
 * POST /api/creative/analyze
 * 创作进化系统阶段 4：对一篇已生成作品做五维 AI 诊断，结果写入
 * generation_history.analysis（jsonb）。仅登录用户、仅能诊断自己的作品
 * （RLS + 显式归属双保险）。已有诊断时幂等返回，force=true 才重新计费分析。
 */
export async function POST(req: Request) {
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

    // 限流（跨实例）：五维诊断是一次完整 LLM 调用。已有诊断会幂等返回，
    // 但 force=true 会真实计费，必须在入口挡住刷量。
    const limited = await guardRateLimit(user.id, 'creative-analyze', 5, 60_000)
    if (limited) return limited

    const body = (await req.json().catch(() => ({}))) as RequestBody
    const generationId = str(body.generationId, 200)
    if (!generationId) {
      return NextResponse.json({ error: '缺少作品 ID' }, { status: 400 })
    }
    const force = body.force === true

    // ── 定位作品行（RLS 已限定本人；maybeSingle 在无行/他人行时都返回 null）──
    const { data: row, error: rowErr } = await supabase
      .from('generation_history')
      .select(
        'id, user_id, topic, identity_label, style, category, sample_text, blueprint, analysis'
      )
      .eq('id', generationId)
      .maybeSingle()

    if (rowErr) {
      console.error('查询待诊断作品失败:', rowErr)
      return NextResponse.json({ error: '查询失败' }, { status: 500 })
    }
    if (!row || row.user_id !== user.id) {
      return NextResponse.json({ error: '作品不存在' }, { status: 404 })
    }
    const sampleText = typeof row.sample_text === 'string' ? row.sample_text : ''
    if (!sampleText.trim()) {
      return NextResponse.json({ error: '作品内容为空，无法诊断' }, { status: 400 })
    }

    // ── 创作一致性三问：与诊断并行，纯读取、失败降级为 null ──
    const consistency = await buildConsistency(
      supabase,
      user.id,
      sampleText,
      str(row.topic, 500)
    )

    // ── 幂等：已有诊断直接返回（前端刷新/切换版本不重复消耗 LLM）──
    if (!force && row.analysis) {
      const cached = parseDiagnosis(row.analysis)
      if (cached) {
        return NextResponse.json({ analysis: cached, cached: true, consistency })
      }
    }

    // ── 调用诊断 LLM ──
    const result = await generateDiagnosis(
      {
        topic: str(row.topic, 500),
        identityLabel: str(row.identity_label, 200),
        style: str(row.style, 500),
        category: str(row.category, 100),
        blueprint: blueprintFromRaw(row.blueprint),
        sampleText,
      },
      // 计费上下文（需求 §12）：调用前原子预扣，调用后按真实 token 结算，
      // 失败全额退。余额不足时 generateDiagnosis 直接返回，一个 token 都不发。
      { supabase, userId: user.id, refId: crypto.randomUUID() }
    )
    if (!result.ok) {
      // 积分不足不是"服务出错"：报 502 会让用户反复重试却永远不知道卡在哪，
      // 必须直接指到充值。
      if (result.error === 'insufficient_points') {
        return NextResponse.json(
          { error: INSUFFICIENT_POINTS_MESSAGE, code: 'insufficient_points' },
          { status: 402, headers: { 'Cache-Control': 'no-store' } }
        )
      }
      // 文案按失败原因区分：余额耗尽（402）、超时、网络故障各不相同。
      // 尤其不能把所有失败都说成"请稍后重试"——余额问题重试一万次也不会好。
      // 网络类用 503（与 lib/apiAuth 同口径：可用性问题不是鉴权问题，前端不得据此踢登录态）。
      const status = isLlmNetworkError(result.error) ? 503 : 502
      return NextResponse.json(
        { error: llmUserMessage(result.error), detail: result.error },
        { status, headers: { 'Cache-Control': 'no-store' } }
      )
    }

    const analysis: CreativeDiagnosis = {
      ...result.data,
      diagnosedAt: new Date().toISOString(),
    }

    // ── 写回 analysis（写失败不影响本次返回，下次 force 重试即可）──
    const { error: updateErr } = await supabase
      .from('generation_history')
      .update({ analysis })
      .eq('id', generationId)
    if (updateErr) {
      console.error('诊断结果写库失败（结果仍返回给前端）:', updateErr)
    }

    return NextResponse.json({ analysis, cached: false, consistency })
  } catch (error) {
    console.error('creative analyze API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
