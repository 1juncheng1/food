// ============================================================
// Creator Interest Profile —— 存量数据回填（一次性脚本逻辑）
//
// 把 M1 埋点之前的存量业务数据转换为 creator_events 事件：
//   1. generation_history            → work_generate（取 V1 根治版本重复计票）
//   2. creative_projects             → work_finalize（status=finalized 的）
//   3. generation_feedback           → feedback_like / feedback_dislike / work_edit / work_regenerate
//   4. post_interactions             → post_like / post_save / post_style_resonate
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
  eventsInserted: number
  errors: number
}

export async function runBackfill(
  supabase: SupabaseClient,
  userId: string
): Promise<BackfillStats> {
  const stats: BackfillStats = { projects: 0, feedback: 0, interactions: 0, eventsInserted: 0, errors: 0 }

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

      // 查 post 拿 excerpt 和 style_vector
      const { data: post } = await supabase
        .from('posts')
        .select('title, excerpt, style_vector, category')
        .eq('id', it.post_id)
        .maybeSingle()

      const r = await trackEvent(supabase, userId, {
        type: eventType,
        targetType: 'post',
        targetId: it.post_id as string,
        embedding: Array.isArray(post?.style_vector) ? (post!.style_vector as number[]) : null,
        topicExcerpt: (post?.title as string) || (post?.excerpt as string) || null,
        payload: {
          post_category: (post?.category as string) || null,
          post_excerpt: cleanTopicExcerpt(post?.excerpt as string | undefined),
        },
        occurredAt: it.created_at as string,
      })
      if (r.ok) stats.eventsInserted++
    }
  }

  return stats
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
