import { NextResponse } from 'next/server'
import {
  authenticateWithToken,
  extractBearerToken,
} from '@/lib/storage'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

/**
 * 剔除内部实现字段后再写入导出文件：
 * style_vector / embedding 是 1024 维模型向量，对"我的数据"导出毫无意义，
 * 却会让 JSON 体积暴涨数倍。其余列一律保留——导出功能的价值在于完整性，
 * 宁可多导也不错导。
 */
function stripInternalFields(rows: unknown[] | null): unknown[] {
  if (!rows) return []
  return rows.map((row) => {
    if (typeof row !== 'object' || row === null) return row
    const { style_vector: _sv, embedding: _emb, ...rest } = row as Record<string, unknown>
    return rest
  })
}

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
    if (!auth.ok) return auth.response
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
        // 这里用 select('*') 而不是手写列白名单：这三张表的列分散在 setup.sql 的
        // 多处 alter table 里（posts 有 post_type/archive/source_project_id，
        // generation_history 有 blueprint/analysis/generation_mode/...），
        // 手写列名一旦对不上，PostgREST 会直接返回 42703 undefined_column 让导出整体失败。
        // 内部大字段改用下面的 stripInternalFields 在返回前剔除。
        supabase
          .from('posts')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false }),
        supabase.from('scripts').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
        supabase
          .from('generation_history')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false }),
        supabase
          .from('generation_feedback')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false }),
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
      posts: stripInternalFields(posts.data),
      scripts: stripInternalFields(scripts.data),
      generationHistory: stripInternalFields(genHistory.data),
      generationFeedback: stripInternalFields(genFeedback.data),
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
        // 导出文件含全量个人数据，禁止任何中间层/浏览器缓存
        'Cache-Control': 'no-store, private',
      },
    })
  } catch (error) {
    console.error('export-data 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
