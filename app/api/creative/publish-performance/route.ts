// ============================================================
// GET /api/creative/publish-performance —— 发布表现观测口
//
// 存在意义：
//   「作品发布后到底怎么样」此前完全没有回流：post_interactions 只被 backfill
//   拿去反推兴趣，创作者永远看不到自己的哪类内容真正被需要。
//   本口子把 posts 的点赞/收藏/评论聚合成事实包，供校准与后续诊断消费。
//
// 定位：纯观测工具。只读、不写库、不调 LLM、无前端依赖。
//   当前没有 UI 消费它是有意为之：发布率仅 2.6%，绝大多数用户只有 0~1 篇
//   已发布作品，此时画图等于把噪声当结论。先用这个口子验证指标有效，
//   再谈展示。事实包会在样本不足时明确给出 caveat，而不是输出空排名。
//
// ⚠️ 使用约束（响应里也带一份，防止调用方误用）：
//   本指标【不可横向跨用户比较】。互动量受粉丝基数与发布时间影响，
//   只能纵向看同一用户自己的趋势。
// ============================================================

import { NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rateLimit'
import { authenticateWithToken } from '@/lib/storage'
import {
  computePublishPerformance,
  fetchPublishFacts,
} from '@/lib/creative/publishPerformance'

export const dynamic = 'force-dynamic'

// 只读查询，成本远低于 LLM 类路由，给到 30 次/分钟
const RATE_LIMIT = 30
const RATE_WINDOW_MS = 60_000

const DISCLAIMER =
  '本指标不可横向跨用户比较：互动量受粉丝基数与发布时间影响，只能纵向看同一用户的趋势。'

export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const auth = await authenticateWithToken(token, '请先登录')
    if (!auth.ok) return auth.response

    const rl = rateLimit(
      `creative-publish-performance:${auth.userId}`,
      RATE_LIMIT,
      RATE_WINDOW_MS
    )
    if (!rl.ok) {
      return NextResponse.json(
        { error: `操作太频繁，请 ${rl.retryAfterSec} 秒后再试` },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    const facts = await fetchPublishFacts(auth.supabase, auth.userId)
    const report = computePublishPerformance(facts, new Date())

    return NextResponse.json({
      publishedCount: report.publishedCount,
      totals: report.totals,
      perPostAvg: report.perPostAvg,
      // 保存率比点赞更接近"有用"：区分"被喜欢"和"被需要"
      saveRatio: report.saveRatio,
      commentRatio: report.commentRatio,
      byCategory: report.byCategory,
      byTag: report.byTag,
      bestCategory: report.bestCategory,
      confidence: report.confidence,
      caveat: report.caveat,
      disclaimer: DISCLAIMER,
    })
  } catch (error) {
    console.error('publish-performance API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
