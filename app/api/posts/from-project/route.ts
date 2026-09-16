import { NextResponse } from 'next/server'
import { CATEGORIES } from '@/lib/constants'
import { rateLimit } from '@/lib/rateLimit'
import {
  authenticateWithToken,
  extractBearerToken,
  generateEmbedding,
} from '@/lib/storage'
import { parseVector, updateUserStyleVector } from '@/lib/styleVector'
import {
  archiveFeedText,
  buildArchiveSnapshot,
  type ArchiveSnapshot,
} from '@/lib/creative/archive'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

type ShareMode = 'work' | 'inspiration' | 'archive'
const VALID_MODES: readonly ShareMode[] = ['work', 'inspiration', 'archive']

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** 标签支持字符串数组或逗号分隔字符串，最多 10 个、每个 20 字 */
function parseTags(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v.filter((t): t is string => typeof t === 'string')
    : typeof v === 'string'
      ? v.split(/[,，]/)
      : []
  return raw
    .map((t) => t.trim().slice(0, 20))
    .filter(Boolean)
    .slice(0, 10)
}

// ────────────────────────────────────────────────────────────
// POST /api/posts/from-project
// 把一个创作项目发布到灵感广场：
//   mode=work        → 普通帖，内容为最终作品全文
//   mode=inspiration → 普通帖，内容为灵感来源/创作初衷
//   mode=archive     → 创作档案帖，archive jsonb 为发布瞬间的只读快照
// 快照只能由服务端从 creative_projects + generation_history 构建（防伪造、防残缺）。
// ────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  try {
    const token = extractBearerToken(req)
    if (!token) return NextResponse.json({ error: '请先登录' }, { status: 401 })
    const auth = await authenticateWithToken(token)
    if (!auth) {
      return NextResponse.json({ error: '登录已过期，请重新登录' }, { status: 401 })
    }
    const { supabase, userId } = auth

    const rl = rateLimit(`posts-from-project:${userId}`, 5, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      )
    }

    let body: {
      projectId?: unknown
      mode?: unknown
      inspirationText?: unknown
      authorSummary?: unknown
      tags?: unknown
      category?: unknown
    }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: '请求体无效' }, { status: 400 })
    }

    const projectId = str(body.projectId, 100)
    const mode = VALID_MODES.includes(body.mode as ShareMode)
      ? (body.mode as ShareMode)
      : null
    if (!projectId || !mode) {
      return NextResponse.json(
        { error: '缺少必要参数（projectId / 有效的分享模式）' },
        { status: 400 }
      )
    }
    if (projectId.includes('::')) {
      return NextResponse.json({ error: 'projectId 无效' }, { status: 400 })
    }

    // ── 加载项目（RLS 已隔离他人项目，再做一次显式归属校验）──
    const { data: project, error: projErr } = await supabase
      .from('creative_projects')
      .select('id, user_id, title, topic, status, current_version')
      .eq('id', projectId)
      .maybeSingle()

    if (projErr || !project || project.user_id !== userId) {
      return NextResponse.json({ error: '创作项目不存在或无权访问' }, { status: 404 })
    }

    // ── 加载全部版本（正序）──
    const { data: rows, error: verErr } = await supabase
      .from('generation_history')
      .select(
        'id, version_number, improve_direction, improve_note, sample_text, blueprint, category, style, identity_label, created_at'
      )
      .eq('project_id', projectId)
      .order('version_number', { ascending: true })

    if (verErr || !rows || rows.length === 0) {
      return NextResponse.json(
        { error: '作品版本数据缺失，无法发布' },
        { status: 409 }
      )
    }

    const finalVersionNumber =
      typeof project.current_version === 'number'
        ? project.current_version
        : (rows[rows.length - 1].version_number as number)
    const latestRow =
      rows.find((r) => r.version_number === finalVersionNumber) ?? rows[rows.length - 1]
    const finalWork = str(latestRow.sample_text, 20000)
    if (!finalWork) {
      return NextResponse.json({ error: '最终作品内容为空，无法发布' }, { status: 409 })
    }

    const title = str(project.title, 200) || str(project.topic, 200) || '未命名创作'
    const identityLabel = str(latestRow.identity_label, 60)
    const styleText = str(latestRow.style, 100)
    const styleTags = [identityLabel, styleText].filter(Boolean)

    // ── 按模式组装内容 ──
    const userTags = parseTags(body.tags)
    const fallbackCategory = (CATEGORIES as readonly string[]).includes(
      str(latestRow.category, 50)
    )
      ? str(latestRow.category, 50)
      : CATEGORIES[0]
    const category =
      typeof body.category === 'string' &&
      (CATEGORIES as readonly string[]).includes(body.category)
        ? body.category
        : fallbackCategory

    let content = ''
    let postType: 'moment' | 'archive' = 'moment'
    let archive: ArchiveSnapshot | null = null

    if (mode === 'work') {
      content = `# ${title}\n\n${finalWork}`.slice(0, 10000)
    }

    if (mode === 'inspiration') {
      const inspiration = str(body.inspirationText, 2000)
      if (inspiration.length < 5) {
        return NextResponse.json(
          { error: '请填写灵感来源（至少 5 个字）' },
          { status: 400 }
        )
      }
      content = inspiration
    }

    if (mode === 'archive') {
      const inspiration =
        str(body.inspirationText, 2000) ||
        str(project.topic, 2000) ||
        title
      if (inspiration.length < 5) {
        return NextResponse.json(
          { error: '灵感起点内容过短，无法生成创作档案' },
          { status: 400 }
        )
      }
      const authorSummaryRaw = str(body.authorSummary, 500)
      archive = buildArchiveSnapshot({
        title,
        inspiration,
        authorSummary: authorSummaryRaw || null,
        styleTags,
        versions: rows.map((r) => ({
          versionNumber: r.version_number as number,
          improveDirection: (r.improve_direction as string | null) ?? null,
          improveNote: (r.improve_note as string | null) ?? null,
          sampleText: r.sample_text as string,
          blueprint: r.blueprint,
          createdAt: r.created_at as string,
        })),
        finalVersionNumber,
      })
      if (!archive) {
        return NextResponse.json({ error: '档案构建失败：版本内容不完整' }, { status: 409 })
      }
      postType = 'archive'
      content = archiveFeedText(archive)
    }

    if (!content) {
      return NextResponse.json({ error: '发布内容不能为空' }, { status: 400 })
    }

    // ── 向量化（embedding 文本：灵感语 + 标签 + 最终作开头，复用现有推荐链路）──
    const embedSource =
      mode === 'archive'
        ? `${archive!.inspiration}\n${(userTags.join(' ') || category)}\n${finalWork.slice(0, 2000)}`
        : content.slice(0, 4000)
    const embedding = await generateEmbedding(embedSource)
    const styleVector = embedding ? parseVector(embedding) : null

    const { data: inserted, error: insertErr } = await supabase
      .from('posts')
      .insert({
        user_id: userId,
        content,
        content_type: 'text',
        category,
        tags: userTags.length ? userTags : [category],
        style_vector: styleVector,
        is_public: true,
        post_type: postType,
        archive,
        source_project_id: projectId,
      })
      .select('id')
      .single()

    if (insertErr || !inserted) {
      console.error('创作档案发布失败:', insertErr)
      return NextResponse.json(
        {
          error:
            '数据库列可能尚未更新（请确认已执行 setup.sql 中 posts 新列迁移），或稍后重试',
        },
        { status: 500 }
      )
    }

    // 发布后异步更新用户风格向量（与普通发帖一致；失败不影响发布结果）
    if (embedding) {
      void updateUserStyleVector(supabase, userId, embedding).catch(() => {})
    }

    return NextResponse.json({
      success: true,
      postId: inserted.id as string,
      postType,
    })
  } catch (err) {
    console.error('from-project 发布异常:', err)
    return NextResponse.json({ error: '发布失败，请稍后重试' }, { status: 500 })
  }
}
