// ============================================================
// Creator Interest Profile —— 三表读写 + 单事务提交（IO 薄封装）
//
// 所有数据库操作集中在此，builder 只调这里的函数。
// Supabase JS 客户端无原生事务，用 RPC（SECURITY INVOKER）包装提交。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseVectorColumn } from './vectorMath'
import { ALGO_VERSION, RULE_VERSION, BUILD_STALE_RUNNING_MS } from './config'
import type { EngineEvent } from './types'

// ── 查询 ──

export async function findRunningBuild(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  // 只认新鲜 running：started_at 在僵尸窗口内。超过 BUILD_STALE_RUNNING_MS 未完成的
  // 行视为进程中断遗留（dev 热重载/serverless 冻结），不能让它永久折叠新 build。
  const freshSince = new Date(Date.now() - BUILD_STALE_RUNNING_MS).toISOString()
  const { data, error } = await supabase
    .from('interest_builds')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'running')
    .gte('started_at', freshSince)
    // interest_builds 只有 started_at（无 created_at）；错列名会被 PostgREST 报错，
    // 旧代码不检查 error 导致在途折叠恒为 null、并发 build 竞态（WF0 D5 根因）。
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('[interest] 查询在途 build 失败:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * 僵尸 build 回收：查最老的 running 行（不加新鲜过滤），started_at 超过
 * BUILD_STALE_RUNNING_MS 则置 failed 并返回其 id；无僵尸返回 null。
 * 由 runBuild 步骤0 在在途折叠前调用（用户 token/update 失败时不抛，下次重试）。
 */
export async function reapStaleRunningBuild(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('interest_builds')
    .select('id, started_at')
    .eq('user_id', userId)
    .eq('status', 'running')
    .order('started_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('[interest] 僵尸 build 回收查询失败:', error.message)
    return null
  }
  if (!data?.id || !data.started_at) return null
  const ageMs = Date.now() - Date.parse(data.started_at as string)
  if (ageMs < BUILD_STALE_RUNNING_MS) return null

  const { error: updErr } = await supabase
    .from('interest_builds')
    .update({
      status: 'failed',
      error: '僵尸 build 自动回收：超过 5 分钟未完成（进程中断/热重载/serverless 冻结遗留）',
      finished_at: new Date().toISOString(),
    })
    .eq('id', data.id)
    .eq('status', 'running')
  if (updErr) {
    console.error('[interest] 僵尸 build 回收更新失败:', updErr.message)
    return null
  }
  console.warn('[interest] 已回收僵尸 build:', data.id, `(age=${Math.round(ageMs / 1000)}s)`)
  return data.id as string
}

export async function getLastBuild(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase
    .from('interest_builds')
    .select('id, algo_version, rule_version, params, event_range')
    .eq('user_id', userId)
    .eq('status', 'done')
    // 注意：interest_builds 只有 started_at/finished_at，无 created_at（错列名会静默报错返回 null）
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data
}

export async function fetchEvents(
  supabase: SupabaseClient,
  userId: string
): Promise<EngineEvent[]> {
  // 全时间窗拉取（增量/全量统一口径）：撤回裁决（scoring.adjudicateWithdrawals）按
  // target_id 匹配被删目标的原始正向事件，若按"上次 build 游标"截断窗口，窗口内只有
  // 删除事件本身、匹配不到 victim → 删除撤回永远失效，画像与推荐队列永不更新。
  // 计算口径：画像 = f(全部事件) 的确定性重算，而非 f(新增事件)；365 天评分窗口过滤
  // 在 scoring 层完成。
  // limit 2000 兜底超大规模账户：倒序取"最新的 2000 条"再正序回放——正序 limit 会
  // 拿到最老的 2000 条，近期新增/删除事件反被截断，撤回再次失效。
  const { data, error } = await supabase
    .from('creator_events')
    .select('id, event_type, target_type, target_id, project_id, occurred_at, embedding, interpretation, interpret_status, payload')
    .eq('user_id', userId)
    .order('occurred_at', { ascending: false })
    .limit(2000)
  if (error) {
    console.error('[interest] 拉取事件失败:', error)
    return []
  }
  return (data ?? []).reverse().map((r) => {
    // WF9 实测修复：pgvector 经 PostgREST 返回 "[...]" 字符串形态——
    // 旧逻辑 Array.isArray 直接丢弃，回写补算的向量永远读不回来（每次 build 全量重补）。
    // 事件向量固定 1024 维（bge-m3），维度不符视为脏数据 → null（走下轮补算）。
    const emb = parseVectorColumn(r.embedding)
    return {
      id: r.id as string,
      type: r.event_type as EngineEvent['type'],
      targetType: r.target_type as EngineEvent['targetType'],
      targetId: (r.target_id as string) ?? null,
      projectId: (r.project_id as string) ?? null,
      occurredAt: r.occurred_at as string,
      embedding: emb && emb.length === 1024 ? emb : null,
      interpretation: (r.interpretation as EngineEvent['interpretation']) ?? null,
      _topic: (r.payload as Record<string, unknown>)?.topic_excerpt as string | undefined,
      // v4：payload 整体透出（✕ 原因码 reason_code 落在这里，评分 v3 的口味惩罚要读它）。
      // 与 _topic 同形态挂在 EngineEvent 之外，不污染事件类型本体。
      _payload: (r.payload as Record<string, unknown>) ?? null,
    }
  }) as EngineEvent[]
}

export async function fetchPendingInterpretEvents(
  supabase: SupabaseClient,
  userId: string
): Promise<EngineEvent[]> {
  const { data } = await supabase
    .from('creator_events')
    .select('id, event_type, target_type, target_id, project_id, occurred_at, embedding, interpretation, payload')
    .eq('user_id', userId)
    .eq('interpret_status', 'pending')
    .order('occurred_at', { ascending: false })
    .limit(20)
  return (data ?? []).map((r) => ({
    id: r.id as string,
    type: r.event_type as EngineEvent['type'],
    targetType: r.target_type as EngineEvent['targetType'],
    targetId: (r.target_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    occurredAt: r.occurred_at as string,
    embedding: Array.isArray(r.embedding) ? (r.embedding as number[]) : null,
    interpretation: (r.interpretation as EngineEvent['interpretation']) ?? null,
    _topic: (r.payload as Record<string, unknown>)?.topic_excerpt as string | undefined,
  })) as EngineEvent[]
}

export async function fetchActiveClusters(supabase: SupabaseClient, userId: string) {
  // 注意：select 列表必须与表结构严格一致——曾因多选了不存在的 downgrade_streak 列
  // （实际存于 stats jsonb 内）导致 PostgREST 每次报错返回空数组，supersede 与跨期继承
  // 从未生效，active 簇无限堆积（生产实锤：全表 0 条 superseded 行）。
  const { data, error } = await supabase
    .from('interest_clusters')
    .select('id, cluster_code, label, summary, centroid, layer, previous_layer, layer_changed_at, weight, confidence, event_count, project_count, first_seen_at, last_seen_at, status, stats, algo_version, tag_dims, tag_embedding')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('weight', { ascending: false })
  if (error) {
    console.error('[interest] fetchActiveClusters 失败:', error.message)
  }
  return data ?? []
}

// ── 写入 ──

export async function createBuild(
  supabase: SupabaseClient,
  userId: string,
  mode: 'incremental' | 'full'
): Promise<string | null> {
  const id = crypto.randomUUID()
  const { error } = await supabase.from('interest_builds').insert({
    id,
    user_id: userId,
    trigger: mode === 'full' ? 'manual' : 'incremental',
    algo_version: ALGO_VERSION,
    rule_version: RULE_VERSION,
    params: { mode, config_snapshot: RULE_VERSION },
    event_range: {},
    status: 'running',
    started_at: new Date().toISOString(),
  })
  if (error) {
    // 23505 = 撞上 interest_builds_one_running_idx 唯一部分索引（已有在途 build）。
    // 这是并发触发下的正常折叠，不是故障：info 级记录，调用方凭 null 跳过即可。
    if (error.code === '23505') {
      console.info('[interest] 已存在在途 build，跳过本次触发')
    } else {
      console.error('[interest] 创建 build 失败:', error)
    }
    return null
  }
  return id
}

export async function finishBuild(
  supabase: SupabaseClient,
  userId: string,
  buildId: string,
  eventRange: { from_event_id: string | null; to_event_id: string | null; count: number },
  profile: Record<string, unknown>
): Promise<boolean> {
  // 1. 更新 build 状态
  const { error: updErr } = await supabase
    .from('interest_builds')
    .update({
      status: 'done',
      event_range: eventRange,
      finished_at: new Date().toISOString(),
    })
    .eq('id', buildId)
  if (updErr) {
    console.error('[interest] 更新 build 状态失败:', updErr)
    return false
  }

  // 2. 写画像：upsert 而非 update——新用户可能没有 style_profiles 行，
  //    update 会更新 0 行导致画像写不进去（/api/inspirations 永远降级到 fallback）
  //    只传 interest_profile + updated_at，其他字段（tone_tags 等）由数据库默认值处理，
  //    避免覆盖用户已有的风格卡数据
  const { error: profileErr } = await supabase
    .from('style_profiles')
    .upsert(
      {
        user_id: userId,
        interest_profile: profile,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )
  if (profileErr) {
    console.error('[interest] 写画像失败:', profileErr)
    return false
  }
  return true
}

export async function failBuild(supabase: SupabaseClient, buildId: string, error: string) {
  await supabase
    .from('interest_builds')
    .update({ status: 'failed', error, finished_at: new Date().toISOString() })
    .eq('id', buildId)
}

/** 旧簇置 superseded，插入新簇，回填事件 cluster_id */
export async function commitClusters(
  supabase: SupabaseClient,
  userId: string,
  buildId: string,
  oldClusterIds: string[],
  newClusters: Array<Record<string, unknown>>,
  eventClusterAssignments: Array<{ eventId: string; clusterId: string | null }>
): Promise<string | null> {
  // 返回 null=成功，否则返回可读错误信息（供 failBuild 写入 interest_builds.error，
  // 之前只返回布尔导致"commitClusters 失败"无法定位真实 DB 错误）
  // 1. 旧簇置 superseded
  if (oldClusterIds.length) {
    const { error: supErr } = await supabase
      .from('interest_clusters')
      .update({ status: 'superseded' })
      .in('id', oldClusterIds)
    if (supErr) {
      console.error('[interest] 旧簇置 superseded 失败:', supErr)
      return `supersede 失败: ${supErr.message}`
    }
  }

  // 2. 插入新簇
  if (newClusters.length) {
    const rows = newClusters.map((c) => ({
      user_id: userId,
      build_id: buildId,
      algo_version: ALGO_VERSION,
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...c,
    }))
    const { error: insErr } = await supabase.from('interest_clusters').insert(rows)
    if (insErr) {
      console.error('[interest] 插入新簇失败:', insErr)
      return `插入新簇失败: ${insErr.message}`
    }
  }

  // 3. 回填事件 cluster_id（批量）
  for (const { eventId, clusterId } of eventClusterAssignments) {
    if (!clusterId) continue
    await supabase
      .from('creator_events')
      .update({ cluster_id: clusterId })
      .eq('id', eventId)
  }

  return null
}

/** 回写事件的原因分析结果 */
export async function updateInterpretation(
  supabase: SupabaseClient,
  updates: Array<{ eventId: string; interpretation: unknown | null; status: 'done' | 'failed' }>
) {
  for (const { eventId, interpretation, status } of updates) {
    await supabase
      .from('creator_events')
      .update({ interpretation, interpret_status: status })
      .eq('id', eventId)
  }
}

/**
 * WF9：补算结果回写 creator_events.embedding——
 * 不回写则每次 build 重复对同一批事件烧 50 次 embedding API（实测 61 条全缺、每次 build 31s+）。
 * 逐条 update，失败记 error 不抛出（回写是优化不是依赖，事件本身已入账）。
 */
export async function saveEventEmbeddings(
  supabase: SupabaseClient,
  updates: Array<{ id: string; embedding: number[] }>
): Promise<void> {
  for (const u of updates) {
    const { error } = await supabase
      .from('creator_events')
      .update({ embedding: u.embedding })
      .eq('id', u.id)
    if (error) {
      console.error('[interest] 回写事件 embedding 失败:', u.id, error.message)
    }
  }
}

/** 获取画像（stale-while-revalidate） */
// WF3：同时取 creator_declaration——assembleProfile 的 creative_goals/content_preference 权威来源
export async function getProfile(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase
    .from('style_profiles')
    .select('interest_profile, creator_declaration')
    .eq('user_id', userId)
    .maybeSingle()
  return {
    profile: (data?.interest_profile as Record<string, unknown>) ?? null,
    declaration: (data?.creator_declaration as Record<string, unknown>) ?? null,
  }
}
