// ============================================================
// Creator Interest Profile —— 事件写入器（服务端统一入口，仅服务端）
//
// 铁律：
//   1. 写路径只做"追加事实"，永不触发 LLM 原因分析、不触发聚类、不阻塞主业务；
//   2. 任何失败只 console.error，trackEvent 永不抛异常（调用方无需 try/catch）；
//   3. 全部事件走幂等 upsert，网络重试/前端重复提交不会重复计票；
//   4. embedding 复用调用方已算好的向量；仅配置允许的纯主题事件按摘录补算，
//      补算失败置 null（事件照常入账，build 时再补）。
//
// 用法：await trackEvent(supabase, userId, { type, targetType, targetId, ... })
// （tracker 内部已吞掉所有异常；await 仅为在 serverless 返回前确保落库）
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateEmbedding } from '@/lib/storage'
import { EMBEDDING_MODEL, EVENT_REGISTRY } from './config'
import { buildIdempotencyKey } from './idempotency'
import {
  cleanEmbedding,
  cleanId,
  cleanOccurredAt,
  cleanText,
  cleanTopicExcerpt,
  sanitizePayload,
} from './normalize'
import type { InterpretStatus, TrackEventInput, TrackEventResult } from './types'

/**
 * 把写库失败翻译成"能照着修"的日志。
 *
 * 存在理由：事件丢失此前是**静默**的。典型场景是新增事件类型（如 work_publish）
 * 但未执行迁移，数据库 CHECK 约束会拒绝插入，而 trackEvent 的铁律是"永不抛异常"，
 * 于是事件无声消失 —— 要等画像长期不准才被发现。这里把两类最需要运维介入的
 * 失败单独点名，让"静默丢失"变成"日志里一眼可见"。
 */
function describeWriteError(error: { message?: string; code?: string }): string {
  const msg = error?.message ?? ''
  // 23514 = CHECK 约束违反：几乎总是"新事件类型未执行迁移"
  // 42P01 = 表不存在；42501 = 权限不足（service key 缺 GRANT 的老问题）
  if (error?.code === '23514' || /violates check constraint/i.test(msg)) {
    return `${msg} —— 极可能是该事件类型未执行迁移（如 0016）导致 CHECK 拒绝，请执行 supabase/migrations 后再验证`
  }
  if (error?.code === '42P01') {
    return `${msg} —— creator_events 表不存在，请先执行 supabase/setup.sql`
  }
  if (error?.code === '42501') {
    return `${msg} —— 权限不足：service_role 对该表缺 GRANT，后台写入会静默失败`
  }
  return msg
}

/**
 * 追加一条创作者行为事件。
 * @returns 永不抛错；ok=false 仅表示落库失败（调用方可忽略）
 */
export async function trackEvent(
  supabase: SupabaseClient,
  userId: string,
  input: TrackEventInput
): Promise<TrackEventResult> {
  const fail = (message: string): TrackEventResult => {
    console.error(`[interest] trackEvent ${input.type} 失败: ${message}`)
    return { ok: false, idempotencyKey: '' }
  }

  try {
    if (!userId) return fail('缺少 userId')
    const registry = EVENT_REGISTRY[input.type]
    if (!registry) return fail(`未知事件类型 ${input.type}`)

    const targetId = input.targetId ? cleanId(input.targetId) : null
    const projectId = input.projectId ? cleanId(input.projectId) : null
    const topicExcerpt = cleanTopicExcerpt(input.topicExcerpt)
    const occurredAt = cleanOccurredAt(input.occurredAt)

    const idempotencyKey = buildIdempotencyKey({
      targetType: input.targetType,
      targetId,
      eventType: input.type,
      daily: input.dailyKey ?? false,
      occurredAt,
    })

    // ── embedding：显式传入优先（含 null=调用方已尝试）；未传且允许补算时按摘录补 ──
    let embedding: number[] | null = null
    if (input.embedding === undefined) {
      if (registry.autoEmbedding && topicExcerpt) {
        embedding = cleanEmbedding(await generateEmbedding(topicExcerpt))
      }
    } else {
      embedding = cleanEmbedding(input.embedding)
    }

    // ── 原因分析初始状态：sample/no 在 M1 一律 none，M2 流水线再挑选 ──
    const interpretStatus: InterpretStatus = registry.interpret === 'yes' ? 'pending' : 'none'

    // ── payload 清洗：topic_excerpt 保证存在（有摘录时），其余按红线截断 ──
    const payload = sanitizePayload(input.payload ?? undefined)
    if (topicExcerpt && typeof payload.topic_excerpt !== 'string') {
      payload.topic_excerpt = topicExcerpt
    }

    const row: Record<string, unknown> = {
      user_id: userId,
      event_type: input.type,
      target_type: input.targetType,
      target_id: targetId,
      project_id: projectId,
      category: cleanText(input.category, 50) || null,
      content_domain: cleanText(input.contentDomain, 50) || null,
      embedding,
      embedding_model: EMBEDDING_MODEL,
      payload,
      interpret_status: interpretStatus,
      idempotency_key: idempotencyKey,
    }
    if (occurredAt) row.occurred_at = occurredAt

    const { error } = await supabase
      .from('creator_events')
      .upsert(row, { onConflict: 'user_id,idempotency_key', ignoreDuplicates: true })

    if (error) return fail(describeWriteError(error))
    return { ok: true, idempotencyKey }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}
