import { NextResponse } from 'next/server'
import { authenticateWithToken, extractBearerToken } from '@/lib/storage'
import { rateLimit } from '@/lib/rateLimit'
import { fetchCreatorStyleProfile } from '@/lib/creative/styleProfileRepo'
import { parseCreatorReport } from '@/lib/creative/creatorReport'
import { callDeepSeekChat, stripJsonFence } from '@/lib/llm'
// 与服务端共用同一句充值文案（Phase 4）
import { INSUFFICIENT_POINTS_MESSAGE } from '@/lib/balance'

export const maxDuration = 45
export const dynamic = 'force-dynamic'

// ────────────────────────────────────────────────────────────
// POST /api/characters/self-draft
// 为「我」角色生成背景/性格草稿：读取创作者 DNA 报告 + 用户一句话补充，
// AI 只出草稿，用户确认编辑后经 POST /api/characters 落库（永不直接写入）。
// 防尬硬约束：只能基于报告与补充生成，严禁编造职业/经历/年龄等"事实"。
// ────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const token = extractBearerToken(req)
    if (!token) return NextResponse.json({ error: '请先登录' }, { status: 401 })
    const auth = await authenticateWithToken(token)
    if (!auth.ok) return auth.response
    const { supabase, userId } = auth

    // 限流：每次草稿都是一次 LLM 调用
    const rl = rateLimit(`character-self-draft:${userId}`, 3, 10 * 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '生成太频繁，请稍后再试', retryAfter: rl.retryAfterSec },
        { status: 429 }
      )
    }

    const body = (await req.json().catch(() => null)) as { hint?: unknown } | null
    const hint = typeof body?.hint === 'string' ? body.hint.trim().slice(0, 100) : ''

    // 读取创作者人格报告（无报告时降级用基础统计，再无则要求手填）
    const profile = await fetchCreatorStyleProfile(supabase, userId)
    const report = parseCreatorReport(profile?.creator_report)
    if (!report && !hint) {
      return NextResponse.json(
        {
          error:
            '还没有可参考的创作理解——先在风格卡让 AI 认识你，或直接在下方补充一句你的身份信息后重试',
          code: 'insufficient_context',
        },
        { status: 409 }
      )
    }

    const lines: string[] = []
    if (report) {
      lines.push(`【创作者 DNA 报告（真实数据，唯一可信来源）】`)
      lines.push(`创作者人格：${report.personality.main}${report.personality.sub ? ` / ${report.personality.sub}` : ''}`)
      lines.push(`AI 对该用户的理解：${report.personality.description}`)
      if (report.motifDna.length)
        lines.push(`持续关注的母题：${report.motifDna.map((m) => m.label).join('、')}`)
      if (report.languageDna.aiLabels.length)
        lines.push(`语言风格：${report.languageDna.aiLabels.join('、')}`)
      lines.push(`声明喜欢的表达元素：${report.bounds.favorite.join('、') || '无'}`)
      lines.push(`声明排斥的元素：${report.bounds.avoid.join('、') || '无'}`)
      lines.push(`样本量：${report.sampleCount} 篇（置信度 ${Math.round(report.confidence * 100)}%）`)
    }
    if (hint) lines.push(`【用户本人补充的一句话（同样可信）】${hint}`)
    lines.push('【基础事实】仅知道：这是一个使用本产品创作解说/故事类内容的用户。其余一概不知。')

    let raw: string
    const llmRes = await callDeepSeekChat({
      temperature: 0.6,
      max_tokens: 400,
      jsonMode: true,
      // 计费（Phase 4）：余额不足直接返回 insufficient_points，不消耗上游 token
      billing: {
        supabase,
        userId,
        ability: 'chat',
        refId: `self-draft:${crypto.randomUUID()}`,
        description: '角色草稿生成',
      },
      messages: [
        {
          role: 'system',
          content: `任务：帮用户为"把用户自己写进故事"生成一个「我」角色的设定草稿（background 身份背景 + personality 性格与说话方式）。
硬性要求：
1. 只能基于给定材料归纳推测，严禁编造具体职业、公司、城市、年龄、姓名等"事实"；背景里允许写"从事内容创作/对xx主题持续感兴趣"这类由材料支撑的描述；
2. background 40-80 字：身份感的模糊勾勒 + 材料中体现的关注领域，不用第二人称，用角色设定口吻（如"长期观察…的内容创作者"）；
3. personality 40-80 字：性格倾向与说话方式（可参考语言风格与排斥元素，如"表达克制、不说教"）；
4. 输出 JSON：{"background":"...","personality":"..."}，不要 markdown 与解释；
5. 材料太少时写得更泛化，宁可空泛不可编造。`,
        },
        { role: 'user', content: lines.join('\n') },
      ],
    })

    if (!llmRes.ok) {
      // 积分不足不是"服务器出错"，不能报 500 让用户反复重试：
      // 必须指到充值，否则用户只会一遍遍点、永远不知道卡在哪。
      if (llmRes.error === 'insufficient_points') {
        return NextResponse.json(
          { error: INSUFFICIENT_POINTS_MESSAGE, code: 'insufficient_points' },
          { status: 402 }
        )
      }
      console.error('self-draft LLM 失败:', llmRes.error)
      return NextResponse.json({ error: '草稿生成失败，请稍后重试' }, { status: 500 })
    }

    raw = llmRes.content
    let background = ''
    let personality = ''
    try {
      const parsed = JSON.parse(stripJsonFence(raw)) as {
        background?: unknown
        personality?: unknown
      }
      if (typeof parsed.background === 'string')
        background = parsed.background.trim().slice(0, 200)
      if (typeof parsed.personality === 'string')
        personality = parsed.personality.trim().slice(0, 200)
    } catch {
      console.warn('self-draft JSON 解析失败:', raw.slice(0, 200))
    }
    if (!background && !personality) {
      return NextResponse.json({ error: 'AI 返回内容异常，请再试一次' }, { status: 502 })
    }

    return NextResponse.json({ draft: { background, personality } })
  } catch (e) {
    console.error('self-draft 错误:', e)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
