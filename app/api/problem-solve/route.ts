// ============================================================
// POST /api/problem-solve —— 2a：非内容类问题的通用求解适配器
//
// 输入：topic（原始问题）+ problem（第一阶段的问题理解 JSON，服务端重新校验）
// 输出：结构化解决方案（title/summary/sections/next_steps/success_check）+ 全文
//
// 可选鉴权：登录用户生成成功后 upsert generation_history（sample_text=全文，
// blueprint={problem_understanding}，category=问题类型）——复用现有历史/
// 双写体系，零表结构变更；游客仅返回结果，由前端 localStorage 兜底。
//
// LLM 失败返回 502，前端展示重试入口，不阻塞其他功能。
// ============================================================

import { NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rateLimit'
import { authenticateWithToken } from '@/lib/storage'
import {
  generateSolution,
  strengthenSolution,
  normalizeSolution,
  formatSolutionFullText,
  type StrengthenReview,
} from '@/lib/creative/problemSolver'
import { normalizeProblem } from '@/lib/creative/blueprint'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

// 文本类 LLM 接口限流口径：10 次/分钟（与项目硬约束一致）
const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000

interface RequestBody {
  topic?: unknown
  problem?: unknown
  generationId?: unknown
  /** 存在时进入补强模式：审视该版方案，产出 review + 补强新版 */
  previousSolution?: unknown
}

function str(v: unknown, maxLen: number): string {
  return typeof v === 'string' ? v.trim().slice(0, maxLen) : ''
}

export async function POST(req: Request) {
  try {
    // ── 可选鉴权：登录用户结果落库，游客纯返回 ──
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const auth = token ? await authenticateWithToken(token) : null

    // ── 限流：登录用户按用户 ID；游客按转发 IP ──
    const clientIp =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip')?.trim() ||
      'unknown'
    const rateKey = auth ? `solve:${auth.userId}` : `solve:guest:${clientIp}`
    const limit = rateLimit(rateKey, RATE_LIMIT, RATE_WINDOW_MS)
    if (!limit.ok) {
      return NextResponse.json(
        { error: `操作太频繁，请 ${limit.retryAfterSec} 秒后再试` },
        { status: 429 }
      )
    }

    const body = (await req.json().catch(() => ({}))) as RequestBody
    const topic = str(body.topic, 500)
    if (!topic) {
      return NextResponse.json({ error: '缺少问题内容' }, { status: 400 })
    }

    // 服务端重新校验问题理解，绝不信任客户端原始 JSON
    const problem = normalizeProblem(body.problem)
    if (!problem) {
      return NextResponse.json(
        { error: '问题理解数据无效，请返回重新分析' },
        { status: 400 }
      )
    }

    // generationId 会作为 generation_history.id 直接 upsert。该列是 text，
    // 且前端用 `${id}::v${n}` 这类复合 id 表示方案版本
    // （见 app/(main)/solution/[id]/page.tsx），后续按同一 id 回查。
    // 因此不能强制 UUID——服务端一旦替换成随机 id，前端就再也查不到该版本。
    // 这里只做长度 + 字符安全校验（排除控制字符/换行/引号），归属仍由 RLS 兜底。
    const rawGenerationId = str(body.generationId, 100)
    const generationId = /^[\w.:@-]+$/.test(rawGenerationId)
      ? rawGenerationId
      : crypto.randomUUID()

    // ── 生成或补强：携带 previousSolution 时走补强迭代 ──
    let solution
    let review: StrengthenReview | null = null
    if (body.previousSolution !== undefined) {
      const previous = normalizeSolution(body.previousSolution)
      if (!previous) {
        return NextResponse.json(
          { error: '上一版方案数据无效，请刷新页面后重试' },
          { status: 400 }
        )
      }
      const outcome = await strengthenSolution({ topic, problem, previous })
      if (!outcome) {
        return NextResponse.json(
          { error: '方案补强失败，请稍后重试' },
          { status: 502 }
        )
      }
      solution = outcome.result
      review = outcome.review
    } else {
      solution = await generateSolution({ topic, problem })
      if (!solution) {
        return NextResponse.json(
          { error: '解决方案生成失败，请稍后重试' },
          { status: 502 }
        )
      }
    }

    const fullText = formatSolutionFullText(solution)

    // ── 登录用户：upsert 生成历史 ──
    // blueprint 存 problem_understanding + solution_result（结构化方案，供跨设备恢复）
    // + review（补强版才有）；正文链路只读 problem_understanding，互不干扰
    if (auth) {
      const vMatch = /::v(\d+)$/.exec(generationId)
      const { error: histErr } = await auth.supabase
        .from('generation_history')
        .upsert(
          {
            id: generationId,
            user_id: auth.userId,
            topic,
            identity_label: problem.recommended_role.slice(0, 200),
            style: vMatch ? `补强版 V${vMatch[1]}` : '',
            category: problem.problem_type.slice(0, 100),
            system_prompt: problem.professional_prompt || null,
            sample_text: fullText,
            blueprint: {
              problem_understanding: problem,
              solution_result: solution,
              ...(review ? { review } : {}),
            },
          },
          { onConflict: 'id' }
        )
      if (histErr) {
        console.error('解决方案历史写入失败（不影响返回）:', histErr)
      }
    }

    return NextResponse.json({
      solution,
      ...(review ? { review } : {}),
      fullText,
      generationId,
    })
  } catch (error) {
    console.error('problem-solve API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
