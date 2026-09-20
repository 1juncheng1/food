// ============================================================
// Creator Interest Profile —— Build 流水线编排（12 步）
//
// 步骤 0: 在途折叠   步骤 1: 建 build 行
// 步骤 2: 拉事件     步骤 3: embedding 补齐
// 步骤 4: 原因批解释 步骤 5: 撤回裁决 + 评分
// 步骤 6: 聚类（已在 scoring 内调用）
// 步骤 7: 跨期继承 + 命名
// 步骤 8: 确定性分层 步骤 9: 趋势
// 步骤 10: 置信度   步骤 11: 装配画像
// 步骤 12: 单事务提交
//
// 任意步骤失败：build=failed，旧画像继续服务，无半成品可见。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateEmbedding } from '@/lib/storage'
import { CLUSTER_INHERIT_SIMILARITY, CLUSTER_MIN_MEMBERS, MAX_ACTIVE_CLUSTERS, EXPLORATION_BATCH_SIZE, AI_REASON_TOP_N } from './config'
import { scoreClusters, type ScoredCluster } from './scoring'
import { decideLayer, detectBurst } from './layering'
import { windowScores, trendDirection, ewma } from './trends'
import { clusterConfidence } from './confidence'
import { assembleProfile, type ClusterView } from './profileAssembly'
import { batchInterpret, reasonWindowFilter } from './reasonAnalyzer'
import { batchNameClusters } from './naming'
import { generateAiReasons } from './reasonAi'
import { batchExtractTagDims, tagDimsToText, tagOverlapFor, pickEmbeddingBackfill, backfillEmbeddings, emptyTagDims } from './tagVector'
import {
  commitClusters,
  createBuild,
  failBuild,
  fetchActiveClusters,
  fetchEvents,
  fetchPendingInterpretEvents,
  findRunningBuild,
  reapStaleRunningBuild,
  finishBuild,
  saveEventEmbeddings,
  updateInterpretation,
} from './interestRepo'
import { ageDays, needsInterpret, effectiveWeight } from './weights'
import { cosineSimilarity, parseVectorColumn } from './vectorMath'
import type { EngineEvent, InterestLayer, TagDims, TrendDirection } from './types'
import { hardFilter, getOwnInspirationCandidates, getSavedMaterialCandidates, getActiveProjectCandidates, type Candidate } from './candidates'
import { getMarketCandidates, getExplorationCandidates, buildExplorationSeeds } from './suggestionSynthesizer'
import { scoreCandidate } from './ranking'
import { insertSuggestions, supersedeOldBuild, type SuggestionInsertInput } from './suggestionRepo'
import { buildFirstWorkSeedCard } from './firstWorkSeed'

export interface BuildResult {
  buildId: string
  status: 'done' | 'failed' | 'duplicate'
  clusterCount: number
  eventCount: number
}

export async function runBuild(
  supabase: SupabaseClient,
  userId: string,
  mode: 'incremental' | 'full' = 'incremental'
): Promise<BuildResult> {
  const now = new Date()

  // ── 步骤 0: 僵尸回收 + 在途折叠 ──
  // 先回收进程中断遗留的陈旧 running 行（dev 热重载/serverless 冻结），
  // 否则该用户后续 build 全部被折叠成 duplicate、前端永久显示"分析中"。
  await reapStaleRunningBuild(supabase, userId)
  const runningId = await findRunningBuild(supabase, userId)
  if (runningId) {
    return { buildId: runningId, status: 'duplicate', clusterCount: 0, eventCount: 0 }
  }

  // ── 步骤 1: 建 build 行 ──
  const buildId = await createBuild(supabase, userId, mode)
  if (!buildId) {
    return { buildId: '', status: 'failed', clusterCount: 0, eventCount: 0 }
  }

  try {
    // ── 步骤 2: 拉事件（全时间窗，增量/全量同口径） ──
    // 此前增量模式按"上次 build 末事件"截断窗口：窗口内只有删除事件、无被撤回的
    // 原始正向事件，撤回裁决 0 匹配 → 删除后画像与推荐队列永不更新（闭环断裂根因）。
    // 改为全窗口重算后，删除/新增立即参与确定性计算。
    const events = await fetchEvents(supabase, userId)
    if (!events.length) {
      // 账本零事件（全新用户）：写空画像让冷启动判定成立。全时间窗口径下本分支
      // 对有数据的用户不可达（fetchEvents 无时间过滤），不存在空画像覆盖风险
      await finishBuild(supabase, userId, buildId, { from_event_id: null, to_event_id: null, count: 0 }, { schema_version: 1, updated_at: now.toISOString(), build_id: buildId, core: [], exploration: [], temporary: [], domains: {}, behavior_reason_summary: { window_days: 90, mix: {} } })
      return { buildId, status: 'done', clusterCount: 0, eventCount: 0 }
    }

    // ── 步骤 3: embedding 补齐（最新优先，批量 ≤50，并发池） + 结果回写 DB ──
    // WF9 实测修复：旧实现正序取头 = 永远补最老的 50 条，新事件永远进不了画像闭环。
    // WF10 修复：串行补算 50 条约 75-100s，build 总耗时 146s 超出前端轮询窗口 →
    // 改 worker pool（并发 6，完成即补位），同批量降至 10-20s。
    const missingEmbed = pickEmbeddingBackfill<EngineEvent>(events, 50)
    if (missingEmbed.length) {
      const backfilled = await backfillEmbeddings(missingEmbed, (topic) => generateEmbedding(topic), 6)
      // 回写：下次 build 这些事件直接带向量，不再重复烧 API（RLS 需 embedding 列级 UPDATE 授权）
      if (backfilled.length) {
        await saveEventEmbeddings(supabase, backfilled)
      }
    }

    // ── 步骤 4: 原因批解释 ──
    const pendingInterpret = await fetchPendingInterpretEvents(supabase, userId)
    const toInterpret = reasonWindowFilter(pendingInterpret).slice(0, 20)
    if (toInterpret.length) {
      // 获取当前活跃簇的 label 供 LLM 参考
      const activeClusters = await fetchActiveClusters(supabase, userId)
      const clusterLabels = activeClusters.map((c) => c.label).filter(Boolean) as string[]
      const interpretResults = await batchInterpret(toInterpret, clusterLabels)
      const updates = interpretResults.map((r) => ({
        eventId: r.eventId,
        interpretation: r.interpretation,
        status: r.interpretation ? 'done' as const : 'failed' as const,
      }))
      await updateInterpretation(supabase, updates)
      // 回写到本次 events 中的对应条目
      for (const r of interpretResults) {
        const ev = events.find((e) => e.id === r.eventId)
        if (ev && r.interpretation) ev.interpretation = r.interpretation
      }
    }

    // ── 步骤 5 + 6: 撤回裁决 + 评分 + 聚类（纯函数，一步到位） ──
    const allScored: ScoredCluster[] = scoreClusters(events, now)

    // 簇质量门槛：单成员簇只是孤立行为，不构成"兴趣方向"，不落库不进画像；
    // 全量重算时事件不丢，后续有同类事件自然达到门槛成簇。
    // 再按 weight 截断 Top N，防止主题极度分散时簇表膨胀。
    const scored: ScoredCluster[] = allScored
      .filter((c) => c.eventCount >= CLUSTER_MIN_MEMBERS)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_ACTIVE_CLUSTERS)

    if (!scored.length) {
      // 全窗口评分后仍无簇 = 兴趣被真实撤空（如删除全部作品）或事件全部过期。
      // 必须同时做两件事，否则删除后旧推荐卡永远 active（"推荐不变"的直接根因）：
      //   ① supersede 旧推荐卡队列 → 队列空让 /api/inspirations 诚实降级"平台推荐选题"
      //   ② 落空画像（build_id 存在 → hasProfile=true）防止每次进页重复触发 full build
      // 全时间窗口径下本分支结果可信，不存在"窗口截断导致的假空"。
      await supersedeOldBuild(supabase, userId)

      // 行为B（首篇即时反馈）：无成簇但存在孤立的非负子簇（典型：用户只创作了 1 篇，
      // 单成员簇被 CLUSTER_MIN_MEMBERS=2 滤掉）→ 产 1 张相邻方向探索引导卡，
      // 让第 1 篇创作后即有个性化反馈。事件被真实撤空/全过期时 allScored 为空，函数返回 0。
      await buildFirstWorkSeedCard(supabase, userId, buildId, allScored, now)

      await finishBuild(supabase, userId, buildId, { from_event_id: events[0].id, to_event_id: events[events.length - 1].id, count: events.length }, { schema_version: 1, updated_at: now.toISOString(), build_id: buildId, core: [], exploration: [], temporary: [], domains: {}, behavior_reason_summary: { window_days: 90, mix: {} } })
      return { buildId, status: 'done', clusterCount: 0, eventCount: events.length }
    }

    // ── 步骤 7: 跨期继承 + 命名 ──
    const oldClusters = await fetchActiveClusters(supabase, userId)
    const oldClusterIds = oldClusters.map((c) => c.id as string)

    // 尝试跨期继承：新质心与旧 active 簇质心匹配
    const inherited = new Map<number, { code: string; label: string; summary: string; firstSeenAt: string; previousLayer: InterestLayer | null; downgradeStreak: number; prevD30: number | null; prevEwma: number | null; tagDims: TagDims | null; tagEmbedding: number[] | null }>()
    const newClustersToName: Array<{ tempId: string; topics: string[]; scoredIdx: number }> = []

    for (let i = 0; i < scored.length; i++) {
      const c = scored[i]
      let bestSim = CLUSTER_INHERIT_SIMILARITY
      let bestOld: typeof oldClusters[number] | null = null
      for (const old of oldClusters) {
        const oldCentroid = (old.centroid as number[]) ?? []
        if (!oldCentroid.length || !c.centroid.length) continue
        const sim = cosineSimilarity(c.centroid, oldCentroid)
        if (sim >= bestSim) {
          bestSim = sim
          bestOld = old
        }
      }
      if (bestOld) {
        inherited.set(i, {
          code: bestOld.cluster_code as string,
          label: bestOld.label as string,
          summary: (bestOld.summary as string) ?? '',
          firstSeenAt: bestOld.first_seen_at as string,
          previousLayer: (bestOld.layer as InterestLayer) ?? null,
          downgradeStreak: ((bestOld.stats as Record<string, unknown>)?.downgradeStreak as number) ?? 0,
          prevD30: ((bestOld.stats as Record<string, unknown>)?.windows as Record<string, number>)?.d30 ?? null,
          prevEwma: ((bestOld.stats as Record<string, unknown>)?.trend as Record<string, number>)?.ewma ?? null,
          // WF4：标签跨期继承（旧行无标签时 null → 评分兜底 1，不丢老用户标签）
          tagDims: (bestOld.tag_dims as TagDims | null) ?? null,
          tagEmbedding: parseVectorColumn(bestOld.tag_embedding),
        })
      } else {
        newClustersToName.push({
          tempId: `new-${i}`,
          topics: c.members.map((m) => (m as EngineEvent & { _topic?: string })._topic).filter(Boolean).slice(0, 5) as string[],
          scoredIdx: i,
        })
      }
    }

    const namingResults = await batchNameClusters(newClustersToName)

    // ── 步骤 7.5: 四维标签（WF4）──
    // 新簇：DeepSeek 批量抽取 + bge-m3 计算 tag_embedding；
    // 继承簇：沿用旧簇标签（标签是簇的长期属性，不随每次 build 重抽）。
    // 失败降级：抽取失败/无 key → 空标签 → 评分兜底 1，build 不阻塞。
    const tagExtractionInputs = newClustersToName.map((n) => {
      const naming = namingResults.get(n.tempId)
      return {
        tempId: n.tempId,
        label: naming?.label ?? '新兴趣',
        summary: naming?.summary ?? '',
        keywords: naming?.keywords ?? [],
        topics: n.topics,
      }
    })
    const extractedTags = await batchExtractTagDims(tagExtractionInputs)
    const tagsByClusterIdx = new Map<number, { tagDims: TagDims; tagEmbedding: number[] | null }>()
    for (let i = 0; i < scored.length; i++) {
      const inh = inherited.get(i)
      if (inh) {
        if (inh.tagDims || inh.tagEmbedding) {
          tagsByClusterIdx.set(i, { tagDims: inh.tagDims ?? emptyTagDims(), tagEmbedding: inh.tagEmbedding })
        }
        continue
      }
      const t = extractedTags.get(`new-${i}`)
      if (t && tagDimsToText(t)) {
        const emb = await generateEmbedding(tagDimsToText(t))
        tagsByClusterIdx.set(i, { tagDims: t, tagEmbedding: emb && emb.length === 1024 ? emb : null })
      }
    }

    // ── 步骤 8: 确定性分层 ──
    // ── 步骤 9: 趋势 ──
    // ── 步骤 10: 置信度 ──
    const clusterViews: ClusterView[] = []
    const newClusterRows: Array<Record<string, unknown>> = []
    const eventClusterAssignments: Array<{ eventId: string; clusterId: string | null }> = []
    // 步骤 13 用：每簇的 centroid/layer/weight/lastSeenAt/label/eventCount，供候选匹配
    const clusterData: Array<{
      clusterId: string
      centroid: number[]
      layer: InterestLayer
      weight: number
      confidence: number
      trend: TrendDirection
      lastSeenAt: string
      label: string
      code: string
      eventCount: number
      createCount: number
      finalizeCount: number
      saveCount: number
      projectIds: string[]
      tagDims: TagDims | null
      tagEmbedding: number[] | null
    }> = []

    for (let i = 0; i < scored.length; i++) {
      const c = scored[i]
      const inh = inherited.get(i)
      const naming = namingResults.get(`new-${i}`)
      // WF4：本簇标签（继承或新抽；无 → null 列 + 评分兜底）
      const tagInfo = tagsByClusterIdx.get(i) ?? null

      const code = inh?.code ?? naming?.slug ?? `c_${Math.random().toString(36).slice(2, 8)}`
      const label = inh?.label ?? naming?.label ?? '新兴趣'
      const summary = inh?.summary ?? naming?.summary ?? ''
      const keywords = naming?.keywords ?? []
      const firstSeenAt = inh?.firstSeenAt ?? c.firstSeenAt

      // 分层
      const burst = detectBurst(c.members.map((m) => m.occurredAt))
      const ageD = ageDays(firstSeenAt, now)
      const layerInput = {
        ageDays: ageD,
        projectCount: c.projectCount,
        eventCount: c.eventCount,
        weight: c.weight,
        genuineRatio: c.genuineRatio,
        burst,
      }
      const layerDecision = inh?.previousLayer
        ? decideLayer(layerInput, { layer: inh.previousLayer, downgradeStreak: inh.downgradeStreak })
        : decideLayer(layerInput, null)

      // 趋势
      const w = windowScores(c.members, now)
      const trend = trendDirection(w, inh?.prevD30 ?? null)
      const trendEwma = ewma(inh?.prevEwma ?? null, w.d30)

      // 置信度
      const interpretableCount = c.members.filter((m) => needsInterpret(m.type)).length
      const interpretedCount = c.members.filter((m) => needsInterpret(m.type) && m.interpretation).length
      const confidence = clusterConfidence(
        { projectCount: c.projectCount, members: c.members, now },
        interpretableCount,
        interpretedCount
      )

      // 证据 top5
      const topEvidence = c.members
        .sort((a, b) => effectiveWeight(b, now) - effectiveWeight(a, now))
        .slice(0, 5)
        .map((m) => ({
          event_id: m.id,
          target_id: m.targetId,
          title: ((m as EngineEvent & { _topic?: string })._topic ?? '').slice(0, 30),
          at: m.occurredAt,
          signal: m.type,
        }))

      // domains（从事件 content_domain 聚合，简化版）
      const domains: Record<string, number> = {}
      for (const m of c.members) {
        const d = (m as EngineEvent & { _domain?: string })._domain
        if (d) domains[d] = (domains[d] ?? 0) + 1
      }
      const dSum = Object.values(domains).reduce((s, v) => s + v, 0) || 1
      for (const k of Object.keys(domains)) domains[k] = Math.round((domains[k] / dSum) * 1000) / 1000

      const clusterView: ClusterView = {
        clusterId: crypto.randomUUID(),
        code,
        label,
        summary,
        layer: layerDecision.layer,
        weight: c.weight,
        confidence,
        trend,
        rawScore: c.rawScore,
        eventCount: c.eventCount,
        projectCount: c.projectCount,
        createCount: c.members.filter((m) => m.type === 'work_generate').length,
        finalizeCount: c.members.filter((m) => m.type === 'work_finalize').length,
        saveCount: c.members.filter((m) => m.type === 'material_save').length,
        firstSeenAt,
        lastSeenAt: c.lastSeenAt,
        genuineRatio: c.genuineRatio,
        isNegative: c.isNegative,
        topEvidence: topEvidence as ClusterView['topEvidence'],
        domains,
        keywords,
      }
      clusterViews.push(clusterView)

      // 新簇行
      newClusterRows.push({
        id: clusterView.clusterId,
        cluster_code: code,
        label,
        summary,
        centroid: c.centroid,
        tag_dims: tagInfo?.tagDims ?? null,
        tag_embedding: tagInfo?.tagEmbedding ?? null,
        layer: layerDecision.layer,
        previous_layer: inh?.previousLayer ?? null,
        layer_changed_at: layerDecision.changed ? now.toISOString() : null,
        weight: c.weight,
        raw_score: c.rawScore,
        confidence,
        event_count: c.eventCount,
        project_count: c.projectCount,
        first_seen_at: firstSeenAt,
        last_seen_at: c.lastSeenAt,
        status: 'active',
        stats: {
          windows: w,
          trend: { direction: trend, slope: 0, ewma: trendEwma },
          top_evidence: topEvidence,
          domains,
          keywords,
          downgradeStreak: layerDecision.downgradeStreak,
        },
      })

      // 事件归属
      for (const m of c.members) {
        eventClusterAssignments.push({ eventId: m.id, clusterId: clusterView.clusterId })
      }

      // 步骤 13 用：每簇的统计信息
      const createCount = c.members.filter((m) => m.type === 'work_generate').length
      const finalizeCount = c.members.filter((m) => m.type === 'work_finalize').length
      const saveCount = c.members.filter((m) => m.type === 'material_save').length
      clusterData.push({
        clusterId: clusterView.clusterId,
        centroid: c.centroid,
        layer: layerDecision.layer,
        weight: c.weight,
        confidence,
        trend,
        lastSeenAt: c.lastSeenAt,
        label,
        code,
        eventCount: c.eventCount,
        createCount,
        finalizeCount,
        saveCount,
        projectIds: [...new Set(c.members.map((m) => m.projectId).filter((x): x is string => !!x))],
        tagDims: tagInfo?.tagDims ?? null,
        tagEmbedding: tagInfo?.tagEmbedding ?? null,
      })
    }

    // ── 步骤 11: 装配画像 ──
    const firstAt = events[0].occurredAt
    const lastAt = events[events.length - 1].occurredAt
    // WF3：读创作者声明（creative_goals/content_preference 权威来源，读失败不阻塞 build）
    let declaration: Record<string, unknown> | null = null
    try {
      const { data: declRow } = await supabase
        .from('style_profiles')
        .select('creator_declaration')
        .eq('user_id', userId)
        .maybeSingle()
      declaration = (declRow?.creator_declaration as Record<string, unknown>) ?? null
    } catch {
      // 无声明/读取失败 → 四字段按"无声明"降级（creative_goals 空数组等）
    }
    const profile = assembleProfile({
      buildId,
      clusters: clusterViews,
      events,
      firstEventAt: firstAt,
      lastEventAt: lastAt,
      declaration: declaration as never,
    })

    // ── 步骤 12: 单事务提交 ──
    const commitErr = await commitClusters(
      supabase,
      userId,
      buildId,
      oldClusterIds,
      newClusterRows,
      eventClusterAssignments
    )
    if (commitErr) {
      await failBuild(supabase, buildId, `commitClusters 失败: ${commitErr}`)
      return { buildId, status: 'failed', clusterCount: 0, eventCount: events.length }
    }

    // ── 步骤 13: 候选生成 ──
    // S1/S3/S5 走 user token；S2/S4 用 service role（synthesizer 内部）
    // 非负簇按 weight 排序，供下面取种子（core 优先；core 为空时回退到最强簇，
    // 否则回填/新用户场景 S4 探索候选会整体缺席）
    const positiveClusters = clusterData
      .filter((c) => !clusterViews.find((v) => v.clusterId === c.clusterId)?.isNegative)
      .sort((a, b) => b.weight - a.weight)
    const topCore = positiveClusters.find((c) => c.layer === 'core') ?? positiveClusters[0]
    const topCoreCentroid = topCore?.centroid?.length ? topCore.centroid : null

    // WF11 P1：多兴趣探索种子——从旧版"最强 2 簇 × 2 条"扩到"≤6 簇 + 跨簇融合 × 16 条"。
    // 纯函数内聚排序口径（core 优先 → weight → code），无 core 时自动回退任意层非负簇，
    // 新用户/回填场景 S4 不再缺席；跨簇 combo 不占 6 个单簇名额。
    const { seeds: explorationSeeds, nonCoreLabels, seedClusters } = buildExplorationSeeds(clusterViews)

    const [s1, s2, s3, s4raw, s5] = await Promise.all([
      getOwnInspirationCandidates(supabase, userId),
      getMarketCandidates(topCoreCentroid, 4),
      getSavedMaterialCandidates(supabase, userId),
      getExplorationCandidates(explorationSeeds, nonCoreLabels, { count: EXPLORATION_BATCH_SIZE }),
      getActiveProjectCandidates(supabase, userId),
    ])

    // S4 探索卡的簇关联策略（WF11 P1 扩批后必须覆盖多种子，否则 16 张卡只有 1 张有簇事实）：
    //   1. 首张【单簇】卡升级 core_gap：同核新角度，强制绑定最强种子簇（保留 WF10 行为）
    //   2. 其余单簇卡：LLM 回射的 seed_label 精确命中某个入选种子簇 → 绑该簇（slot 仍 exploration）。
    //      命中失败（模型改写了 label）就保持无簇，绝不模糊匹配。
    //   3. crossSeed 跨簇融合卡永不绑单一簇（evidence 只带 cross_exploration 标记）。
    // 注意：必须绑定到展开后的新对象——步骤 14 用同一引用查 forceBind（WeakMap）。
    const forceBind = new WeakMap<Candidate, { clusterId: string }>()
    const firstSingleIdx = s4raw.findIndex((c) => !c.crossSeed)
    const bindTarget = firstSingleIdx >= 0 ? seedClusters[0] : null
    const s4: Candidate[] = s4raw.map((cand, i) => {
      if (cand.crossSeed) return cand
      if (i === firstSingleIdx && bindTarget) {
        const upgraded = { ...cand, slot: 'core_gap' as const }
        forceBind.set(upgraded, { clusterId: bindTarget.clusterId })
        return upgraded
      }
      if (cand.seedLabel) {
        // combo 种子名（「a」×「b」）不在 seedClusters 中，天然命中不了
        const hit = seedClusters.find((c) => c.label === cand.seedLabel)
        if (hit) {
          const upgraded = { ...cand }
          forceBind.set(upgraded, { clusterId: hit.clusterId })
          return upgraded
        }
      }
      return cand
    })

    const allCandidates: Candidate[] = [...s1, ...s2, ...s3, ...s4, ...s5]

    // hardFilter：用最近 30 天 work_generate 事件 embedding 过滤"已写过"候选
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const { data: writtenRows } = await supabase
      .from('creator_events')
      .select('embedding')
      .eq('user_id', userId)
      .eq('event_type', 'work_generate')
      .gte('occurred_at', thirtyDaysAgo.toISOString())
      .limit(50)
    // 同 WF9 fetchEvents 修复：此处同样经 PostgREST 拿到 "[...]" 字符串形态向量，
    // Array.isArray 会把已回写的向量全部丢弃（"已写过"过滤静默失效）
    const writtenEmbeddings = (writtenRows ?? [])
      .map((r) => parseVectorColumn(r.embedding))
      .filter((e): e is number[] => !!e)

    // 队列已 supersede 在 14 步开始处做；此处 active 队列视为空
    const filtered = hardFilter(allCandidates, writtenEmbeddings, [], [])

    // ── 步骤 14: 五因子打分 + 落 interest_suggestions 队列 ──
    await supersedeOldBuild(supabase, userId)

    if (!filtered.length) {
      await finishBuild(supabase, userId, buildId, { from_event_id: events[0].id, to_event_id: events[events.length - 1].id, count: events.length }, profile)
      return { buildId, status: 'done', clusterCount: clusterViews.length, eventCount: events.length }
    }

    const itemsToInsert: SuggestionInsertInput[] = filtered.map((cand) => {
      // 匹配候选到簇，三级策略：
      //   1. 显式绑定（S4 core_gap 卡强制绑定种子簇）
      //   2. projectId 直连（S5：回填事件带 projectId，同项目必同簇，无需向量猜）
      //   3. embedding 余弦兜底（S1/S3 等无项目归属的候选）
      let matchedCluster: typeof clusterData[number] | null = null

      const bound = forceBind.get(cand)
      if (bound) {
        matchedCluster = clusterData.find((cd) => cd.clusterId === bound.clusterId) ?? null
      }

      if (!matchedCluster && cand.projectId) {
        matchedCluster = clusterData.find((cd) => cd.projectIds.includes(cand.projectId!)) ?? null
      }

      if (!matchedCluster && cand.embedding && cand.embedding.length === 1024) {
        let bestSim = 0.5 // 阈值：低于此视为不匹配
        for (const cd of clusterData) {
          if (!cd.centroid?.length) continue
          const sim = cosineSimilarity(cand.embedding, cd.centroid)
          if (sim > bestSim) {
            bestSim = sim
            matchedCluster = cd
          }
        }
      }

      const daysSinceLastInCluster = matchedCluster
        ? Math.max(0, Math.floor((now.getTime() - Date.parse(matchedCluster.lastSeenAt)) / 86_400_000))
        : null

      // WF5 v2 输入：语义相似度（无簇/无向量=null）+ 簇趋势。
      // WF4：标签命中率 = 候选 embedding × 簇 tag_embedding 余弦（无标签兜底 1）
      const semanticSim =
        matchedCluster && cand.embedding && cand.embedding.length === 1024
          ? Math.round(cosineSimilarity(cand.embedding, matchedCluster.centroid) * 1000) / 1000
          : null

      const scored = scoreCandidate({
        candidate: cand,
        semanticSimilarity: semanticSim,
        trend: matchedCluster?.trend ?? null,
        daysSinceLastInCluster,
        tagOverlapRatio: tagOverlapFor(cand.embedding, matchedCluster?.tagEmbedding),
      })

      // evidence 事实包（推荐解释用，M5 升级）
      // WF11 P1：crossSeed 候选在两分支都打 cross_exploration 标记，
      // 供前端识别"跨界灵感"（AC-3 验收点：融合两个兴趣簇的选题可被显式区分）
      const evidence: Record<string, unknown> = matchedCluster
        ? {
          cluster_label: matchedCluster.label,
          cluster_code: matchedCluster.code,
          facts: [
            { type: 'create', count: matchedCluster.createCount, cluster_label: matchedCluster.label },
            ...(matchedCluster.finalizeCount > 0 ? [{ type: 'finalize', count: matchedCluster.finalizeCount, cluster_label: matchedCluster.label }] : []),
            ...(matchedCluster.saveCount > 0 ? [{ type: 'save', count: matchedCluster.saveCount, cluster_label: matchedCluster.label }] : []),
          ],
          gap_reason: cand.slot === 'core_gap' ? `你在「${matchedCluster.label}」关注但还未写过` : null,
          source: cand.source,
          matched_similarity: semanticSim,
          ...(cand.crossSeed ? { cross_exploration: true } : {}),
        }
        : {
          facts: [],
          source: cand.source,
          gap_reason: cand.source === 'exploration' ? '探索性方向：基于你的兴趣扩展' : null,
          ...(cand.crossSeed ? { cross_exploration: true } : {}),
        }

      return {
        clusterCode: matchedCluster?.code ?? 'no_cluster',
        slot: cand.slot,
        source: cand.source,
        title: cand.title,
        description: cand.description,
        topic: cand.topic,
        formHint: cand.formHint,
        score: scored.score,
        scoreBreakdown: scored.breakdown,
        evidence,
        marketRefs: cand.marketRefs ? { refs: cand.marketRefs } : null,
      }
    })

    // ── 步骤 14.5（WF6 / WF11 P1 扩面）：Top N 批量 AI 推荐理由预制 ──
    // 算法先筛选（v2 评分排序），AI 只解释不筛选。一次 DeepSeek 调用；
    // 失败逐条模板降级，绝不丢卡。素材闭集取自 S3 收藏素材标题。
    // WF11：S4 扩批 16 后队列供给量增大，理由覆盖面同步从 6 扩到 AI_REASON_TOP_N(20)，
    // 否则无限流下滑到第 7 张以后全部退回模板理由（可观测口径：reason_source）。
    const materialTitles = [...new Set(s3.map((c) => c.title))]
    const topIdx = itemsToInsert
      .map((it, i) => ({ it, i }))
      .sort((a, b) => b.it.score - a.it.score)
      .slice(0, AI_REASON_TOP_N)
    if (topIdx.length) {
      const reasonOutputs = await generateAiReasons(
        topIdx.map(({ it }) => ({
          title: it.title,
          clusterLabel: (it.evidence?.cluster_label as string) ?? null,
          facts: (it.evidence?.facts as Array<Record<string, unknown>>) ?? [],
          gapReason: (it.evidence?.gap_reason as string) ?? null,
          materialTitles,
        }))
      )
      topIdx.forEach(({ it }, seq) => {
        const r = reasonOutputs[seq]
        it.coreQuestion = r.coreQuestion
        it.whyRecommend = r.whyRecommend
        it.creationAngle = r.creationAngle
        it.relatedKnowledge = r.relatedKnowledge
        it.reasonSource = r.reasonSource
      })
    }

    const insertedCount = await insertSuggestions(supabase, userId, buildId, itemsToInsert)
    if (insertedCount === 0) {
      console.warn('[interest] build 完成但推荐卡未落库，旧队列已 supersede（可能下次 build 恢复）')
    }

    await finishBuild(supabase, userId, buildId, { from_event_id: events[0].id, to_event_id: events[events.length - 1].id, count: events.length }, profile)

    return { buildId, status: 'done', clusterCount: clusterViews.length, eventCount: events.length }
  } catch (e) {
    await failBuild(supabase, buildId, e instanceof Error ? e.message : String(e))
    return { buildId, status: 'failed', clusterCount: 0, eventCount: 0 }
  }
}
