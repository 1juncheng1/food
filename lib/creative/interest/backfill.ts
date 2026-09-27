// ============================================================
// Creator Interest Profile —— 存量数据回填（一次性脚本逻辑）
//
// 把 M1 埋点之前的存量业务数据转换为 creator_events 事件：
//   1. generation_history            → work_generate（取 V1 根治版本重复计票）
//   2. creative_projects             → work_finalize（status=finalized 的）
//   3. generation_feedback           → feedback_like / feedback_dislike / work_edit / work_regenerate
//   4. post_interactions             → post_like / post_save / post_style_resonate
//   5. posts(source_project_id)      → work_publish（含孤儿引用，刻意不 join 项目表）
//
// 幂等键前缀 backfill:，与实时流 live: 互不冲突，可重复执行。
// embedding 复用存量向量列；无向量的跳过，build 时补算。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { trackEvent } from './eventTracker'
import { cleanTopicExcerpt } from './normalize'

export interface BackfillStats {
  projects: number
  feedback: number
  interactions: number
  publish: number
  eventsInserted: number
  errors: number
}

export async function runBackfill(
  supabase: SupabaseClient,
  userId: string
): Promise<BackfillStats> {
  const stats: BackfillStats = {
    projects: 0,
    feedback: 0,
    interactions: 0,
    publish: 0,
    eventsInserted: 0,
    errors: 0,
  }

  // ──────────────── 1. creative_projects + 首版本 generation_history → work_generate + work_finalize ────────────────
  //
  // 每个项目只取 V1 的 generation_history 行作为 work_generate 事件（根治版本计票）。
  // finalized 的项目额外发 work_finalize。
  const { data: projects, error: projErr } = await supabase
    .from('creative_projects')
    .select('id, title, topic, status, current_version, created_at, updated_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })

  if (projErr) {
    console.error('[backfill] 拉取项目失败:', projErr)
    stats.errors++
  } else if (projects) {
    stats.projects = projects.length
    for (const p of projects) {
      const v1Id = `${p.id}::v1`
      const { data: genRow } = await supabase
        .from('generation_history')
        .select('id, topic, category, embedding, project_id, inspiration_context, work_tags')
        .eq('id', v1Id)
        .maybeSingle()

      // 如果 V1 不存在（老数据可能没版本链），降级查项目下最早的一条
      const fallbackRow = !genRow
        ? (
            await supabase
              .from('generation_history')
              .select('id, topic, category, embedding, project_id, inspiration_context, work_tags')
              .eq('project_id', p.id)
              .order('created_at', { ascending: true })
              .limit(1)
              .maybeSingle()
          ).data
        : null

      const row = genRow ?? fallbackRow
      if (!row) continue

      const contentDomain = extractContentDomain(row.inspiration_context)
      const embedding = Array.isArray(row.embedding) ? (row.embedding as number[]) : null
      const topic = (row.topic as string) || p.topic || ''

      const r1 = await trackEvent(supabase, userId, {
        type: 'work_generate',
        targetType: 'generation',
        targetId: row.id as string,
        projectId: p.id as string,
        category: (row.category as string) || null,
        contentDomain,
        embedding,
        topicExcerpt: topic,
        payload: {
          topic: cleanTopicExcerpt(topic),
          version_number: 1,
          backfill: true,
          project_title: p.title,
        },
        occurredAt: p.created_at as string,
      })
      if (r1.ok) stats.eventsInserted++

      // finalized 的项目追加定稿事件
      if (p.status === 'finalized') {
        const r2 = await trackEvent(supabase, userId, {
          type: 'work_finalize',
          targetType: 'project',
          targetId: p.id as string,
          projectId: p.id as string,
          payload: { final_version: p.current_version, backfill: true },
          occurredAt: p.updated_at as string,
          dailyKey: true,
        })
        if (r2.ok) stats.eventsInserted++
      }
    }
  }

  // ──────────────── 2. generation_feedback → like/dislike/edit/regenerate ────────────────
  //
  // 只回填 like/dislike（最强显式信号）；edit/regenerate 量大且弱信号，跳过避免噪音。
  const { data: feedbacks, error: fbErr } = await supabase
    .from('generation_feedback')
    .select('id, generation_id, user_id, feedback_type, created_at')
    .eq('user_id', userId)
    .in('feedback_type', ['like', 'dislike'])
    .order('created_at', { ascending: true })

  if (fbErr) {
    console.error('[backfill] 拉取反馈失败:', fbErr)
    stats.errors++
  } else if (feedbacks) {
    stats.feedback = feedbacks.length
    for (const fb of feedbacks) {
      // 查 generation_history 拿 project_id
      const { data: gen } = await supabase
        .from('generation_history')
        .select('project_id')
        .eq('id', fb.generation_id)
        .maybeSingle()

      const r = await trackEvent(supabase, userId, {
        type: fb.feedback_type === 'like' ? 'feedback_like' : 'feedback_dislike',
        targetType: 'generation',
        targetId: fb.generation_id as string,
        projectId: (gen?.project_id as string) ?? null,
        occurredAt: fb.created_at as string,
      })
      if (r.ok) stats.eventsInserted++
    }
  }

  // ──────────────── 3. post_interactions → post_like/save/style_resonate ────────────────
  const { data: interactions, error: intErr } = await supabase
    .from('post_interactions')
    .select('id, user_id, post_id, interaction_type, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })

  if (intErr) {
    console.error('[backfill] 拉取广场互动失败:', intErr)
    stats.errors++
  } else if (interactions) {
    stats.interactions = interactions.length
    for (const it of interactions) {
      const eventType = {
        like: 'post_like',
        save: 'post_save',
        style_resonate: 'post_style_resonate',
      }[it.interaction_type as string] as 'post_like' | 'post_save' | 'post_style_resonate' | undefined

      if (!eventType) continue

      // 查 post 拿正文与 style_vector
      // ⚠️ posts 没有 title / excerpt 列（真实列是 content），此前写错列名导致
      // 整段查询 42703 失败 —— 而查询失败只累加 errors、不抛错，表现为
      // "互动事件入账但没有主题"。列名改动之前已被单测的 mock 掩盖。
      const { data: post } = await supabase
        .from('posts')
        .select('content, style_vector, category')
        .eq('id', it.post_id)
        .maybeSingle()

      const r = await trackEvent(supabase, userId, {
        type: eventType,
        targetType: 'post',
        targetId: it.post_id as string,
        embedding: Array.isArray(post?.style_vector) ? (post!.style_vector as number[]) : null,
        topicExcerpt: titleFromContent(post?.content) || null,
        payload: {
          post_category: (post?.category as string) || null,
          post_excerpt: titleFromContent(post?.content),
        },
        occurredAt: it.created_at as string,
      })
      if (r.ok) stats.eventsInserted++
    }
  }

  // ──────────────── 4. posts(source_project_id) → work_publish ────────────────
  //
  // 关键设计：**刻意不 join creative_projects**。
  // 项目被删后 source_project_id 就成了孤儿引用，发布证据随之丢失——
  // 实测就有用户明明发布过、却被算成从未发布（见 CURRENT.md §5.4）。
  // 用 join 会安静地把这批证据过滤掉，而它们恰恰是最需要救回来的。
  // 事件只承诺「发布这件事发生过」，不承诺被引用的项目此刻还存在 ——
  // 外键不允许引用已删项目，故孤儿发布落 project_id=null + payload 留原始 id。
  //
  // 幂等键是 (post, post_id, work_publish)，重复执行不会重复计票。
  // 新增发布由 from-project route 实时入流，两者不冲突。
  const { data: publishedPosts, error: pubErr } = await supabase
    .from('posts')
    .select(
      'id, content, category, tags, post_type, style_vector, source_project_id, created_at'
    )
    .eq('user_id', userId)
    .not('source_project_id', 'is', null)
    .order('created_at', { ascending: true })

  if (pubErr) {
    console.error('[backfill] 拉取发布记录失败:', pubErr)
    stats.errors++
  } else if (publishedPosts) {
    stats.publish = publishedPosts.length

    // 已存在的项目 id 集合（第 1 段已加载）。
    // creator_events.project_id 有指向 creative_projects 的外键：孤儿引用硬写会被
    // 数据库拒绝（23503），而 trackEvent 只 console.error、不抛错 —— 表现为
    // "明明发布过却被算成从未发布"，正是这一段要救回来的那批证据。
    // 因此项目已删时 project_id 置空，原始 id 留进 payload：
    // 事件仍然如实记录「发布这件事发生过」。
    const aliveProjectIds = new Set((projects ?? []).map((p) => p.id as string))

    for (const post of publishedPosts) {
      const sourceProjectId = (post.source_project_id as string | null) ?? null
      const alive = !!sourceProjectId && aliveProjectIds.has(sourceProjectId)

      const r = await trackEvent(supabase, userId, {
        type: 'work_publish',
        targetType: 'post',
        targetId: post.id as string,
        projectId: alive ? sourceProjectId : null,
        category: (post.category as string) || null,
        embedding: Array.isArray(post.style_vector)
          ? (post.style_vector as number[])
          : null,
        topicExcerpt: titleFromContent(post.content) || null,
        payload: {
          post_type: (post.post_type as string) || 'work',
          tags: Array.isArray(post.tags) ? post.tags : [],
          backfill: true,
          orphan_project: !alive,
          source_project_id: sourceProjectId,
        },
        occurredAt: post.created_at as string,
      })
      if (r.ok) stats.eventsInserted++
    }
  }

  return stats
}

/**
 * 从 posts.content 还原标题。
 *
 * posts 表只有 content 一列正文（没有 title / excerpt），发布接口写库时
 * 对 work 模式拼的是 `# 标题\n\n正文`，故取首个非空行并剥掉 markdown 井号；
 * 剥完为空（纯灵感/档案正文首行不是标题）则退回正文开头。
 */
function titleFromContent(content: unknown): string {
  if (typeof content !== 'string' || !content.trim()) return ''
  const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? ''
  const stripped = firstLine.replace(/^#+\s*/, '').trim()
  return cleanTopicExcerpt(stripped) || cleanTopicExcerpt(content)
}

// ── 辅助：从 inspiration_context 提取 content_domain ──
function extractContentDomain(ctx: unknown): string | null {
  if (!ctx || typeof ctx !== 'object') return null
  const obj = ctx as Record<string, unknown>
  // 尝试多个可能路径
  const va = obj.value_assessment as Record<string, unknown> | undefined
  if (va?.content_domain && typeof va.content_domain === 'string') return va.content_domain
  const ic = obj.inspiration_context as Record<string, unknown> | undefined
  if (ic?.content_domain && typeof ic.content_domain === 'string') return ic.content_domain
  return null
}
