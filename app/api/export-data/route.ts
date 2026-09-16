import { NextResponse } from 'next/server'
import {
  authenticateWithToken,
  extractBearerToken,
} from '@/lib/storage'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

// ────────────────────────────────────────────────────────────
// GET /api/export-data：导出用户所有个人数据为 JSON 文件
// 包含：posts、scripts、generation_history、generation_feedback、
//       style_profiles、follows（关注+被关注）
// ────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  try {
    const token = extractBearerToken(req)
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const auth = await authenticateWithToken(token)
    if (!auth) {
      return NextResponse.json({ error: '登录已过期' }, { status: 401 })
    }
    const { supabase, userId } = auth

    // 风格卡：Creator Model / DNA 报告列（9.5/9.6）优先；未迁移环境自动降级旧列
    async function fetchStyleProfile() {
      const full = await supabase
        .from('style_profiles')
        .select(
          'tone_tags, pace_preference, common_opening, avg_length, source, updated_at, creator_personality, topic_preferences, favorite_elements, avoid_elements, ai_creator_summary, creator_report, model_meta, style_dimensions'
        )
        .eq('user_id', userId)
        .maybeSingle()
      if (!full.error) return full
      if (full.error.code === '42703' || /column .* does not exist/i.test(full.error.message)) {
        return supabase
          .from('style_profiles')
          .select('tone_tags, pace_preference, common_opening, avg_length, source, updated_at')
          .eq('user_id', userId)
          .maybeSingle()
      }
      return full
    }

    // 并行查询所有用户数据
    const [posts, scripts, genHistory, genFeedback, styleProfile, following, followers] =
      await Promise.all([
        supabase.from('posts').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
        supabase.from('scripts').select('id, content, type, file_url, category, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
        supabase.from('generation_history').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
        supabase.from('generation_feedback').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
        fetchStyleProfile(),
        supabase.from('follows').select('following_id, created_at').eq('follower_id', userId).order('created_at', { ascending: false }),
        supabase.from('follows').select('follower_id, created_at').eq('following_id', userId).order('created_at', { ascending: false }),
      ])

    // 检查错误（不阻断，仅记录）
    const errors: string[] = []
    if (posts.error) errors.push(`posts: ${posts.error.message}`)
    if (scripts.error) errors.push(`scripts: ${scripts.error.message}`)
    if (genHistory.error) errors.push(`generation_history: ${genHistory.error.message}`)
    if (genFeedback.error) errors.push(`generation_feedback: ${genFeedback.error.message}`)
    if (styleProfile.error) errors.push(`style_profiles: ${styleProfile.error.message}`)
    if (following.error) errors.push(`follows(following): ${following.error.message}`)
    if (followers.error) errors.push(`follows(followers): ${followers.error.message}`)

    const exportData = {
      exportInfo: {
        exportedAt: new Date().toISOString(),
        userId,
        version: '1.0',
      },
      styleProfile: styleProfile.data ?? null,
      posts: posts.data ?? [],
      scripts: scripts.data ?? [],
      generationHistory: genHistory.data ?? [],
      generationFeedback: genFeedback.data ?? [],
      social: {
        following: following.data ?? [],
        followers: followers.data ?? [],
      },
      errors: errors.length > 0 ? errors : undefined,
    }

    // 返回 JSON 文件下载（Content-Disposition: attachment）
    const filename = `moodata-export-${new Date().toISOString().slice(0, 10)}.json`
    return new NextResponse(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (error) {
    console.error('export-data 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
