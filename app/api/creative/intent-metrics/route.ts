// ============================================================
// GET /api/creative/intent-metrics —— 「愿意发布」指标观测口
//
// 存在意义：
//   定义指标不是目的，能用真实数据校准才是。没有这个口子，
//   publicationIntent 的权重与阈值就永远是拍脑袋的数字，
//   我们也无法回答「这次改动让用户更愿意发布了吗」。
//
// 定位：纯观测工具。只读、不写库、不调 LLM、无前端依赖。
//   当前没有 UI 消费它，这是有意为之 —— 指标要先被验证有效，
//   才配拿去做展示；反过来先画图表会把未校准的数字变成伪事实。
//
// ⚠️ 使用约束（响应里也带一份，防止调用方误用）：
//   本指标【不可横向跨用户比较】，只能纵向看同一用户的趋势。
//   分母是全部创作项目，包含用户本就无意公开的作品
//   （比如写内部商业计划书），横向比会把这类用户判成低分。
// ============================================================

import { NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rateLimit'
import { authenticateWithToken } from '@/lib/storage'
import {
  computePublicationIntent,
  fetchIntentFacts,
} from '@/lib/creative/publicationIntent'

export const dynamic = 'force-dynamic'

// 只读查询，成本远低于 LLM 类路由，给到 30 次/分钟
const RATE_LIMIT = 30
const RATE_WINDOW_MS = 60_000

const DISCLAIMER =
  '本指标不可横向跨用户比较，只能纵向看同一用户的趋势：分母包含用户本就无意公开的作品。'

export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const auth = await authenticateWithToken(token, '请先登录')
    if (!auth.ok) return auth.response

    const rl = rateLimit(`creative-intent-metrics:${auth.userId}`, RATE_LIMIT, RATE_WINDOW_MS)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `操作太频繁，请 ${rl.retryAfterSec} 秒后再试` },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    const projects = await fetchIntentFacts(auth.supabase, auth.userId)
    const report = computePublicationIntent({ projects, now: new Date() })

    return NextResponse.json({
      peakLevel: report.peakLevel,
      counts: report.counts,
      rates: report.rates,
      intentScore: report.intentScore,
      confidence: report.confidence,
      // 作品级阶梯：供「什么样的作品能走到 published」归因分析
      ladders: report.ladders,
      disclaimer: DISCLAIMER,
    })
  } catch (error) {
    console.error('intent-metrics API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
