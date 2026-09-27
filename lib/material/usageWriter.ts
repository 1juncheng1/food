// ============================================================
// usageWriter —— Material Library 2.0 Phase 5 material_usages 写入封装
//
// 三个时机写入（封装为独立函数，调用方决定何时触发）：
//   1. recordSuggestedByAi  — retrieve API 返回 AI 推荐列表时，为自动召回项写 suggested_by_ai=true
//   2. markSelectedByUser   — prompt-optimizer 收到 selectedMaterialIds 时，标记 selected_by_user=true
//   3. markActuallyUsed     — prompt-optimizer 生成成功后，标记 actually_used=true + 回填 work_id
//
// 设计约束：
//   - service_role 走 getServiceClient()（复用 lib/ci/store.ts）；null 时静默 return
//   - 内部不限流（限流由调用方控制），内部全 try/catch 吞错
//   - 按 (user_id, material_id, work_id) 业务键归并：已存在则更新，不存在则插入
//     （不能用 Supabase 的 upsert onConflict，原因见 bulkUpsert 注释）
//   - 不阻断主链路：调用方用 `void recordXxx(...)` 触发，不 await
// ============================================================

import { getServiceClient } from '@/lib/ci/store'

/** 写入 material_usages 的标准 upsert 列（不写 id/created_at，DB 自动生成） */
interface UsageRow {
  user_id: string
  material_id: string
  work_id?: string | null
  suggested_by_ai?: boolean
  selected_by_user?: boolean
  actually_used?: boolean
}

/** 业务键：同一 (用户, 素材, 作品) 视为一条记录；work_id 为空用哨兵占位以便区分 */
function usageKey(r: Pick<UsageRow, 'user_id' | 'material_id' | 'work_id'>): string {
  return `${r.user_id}|${r.material_id}|${r.work_id ?? '@null'}`
}

/** 只取出本次真正要写的三个布尔列——未传的列保持原值，不做整体覆盖 */
function flagPatch(r: UsageRow): Record<string, boolean> {
  const patch: Record<string, boolean> = {}
  if (r.suggested_by_ai !== undefined) patch.suggested_by_ai = r.suggested_by_ai
  if (r.selected_by_user !== undefined) patch.selected_by_user = r.selected_by_user
  if (r.actually_used !== undefined) patch.actually_used = r.actually_used
  return patch
}

/**
 * 批量写入：按 (user_id, material_id, work_id) 归并，已存在则只更新本次传了的列。
 *
 * ⚠️ 为什么放弃 Supabase 的 upsert({ onConflict })：
 *   setup.sql 17.4 的唯一索引是**局部索引**：
 *     material_usages_user_material_work_uniq ON (user_id, material_id, work_id) WHERE work_id IS NOT NULL
 *   PostgreSQL 只有在 ON CONFLICT 带 `WHERE <索引谓词>` 时才会推断局部唯一索引，
 *   而 PostgREST / Supabase JS 的 onConflict 只能给列名，无法表达谓词。
 *   实际结果不是原注释以为的"退化为 INSERT"，而是直接报错 42P10
 *   （no unique or exclusion constraint matching the ON CONFLICT specification）；
 *   该错误被本文件的 try/catch 吞掉，导致 material_usages **从未写入过任何一行**，
 *   Phase 5 推荐系统赖以训练的闭环数据一直是空的。
 *
 * 因此改为显式「先查后写」：按业务键查出已有行的 id → 命中走 update、未命中走 insert。
 *   每次调用行数 ≤10，多一次 select 的开销可忽略。
 *   并发下极小概率重复插入的 work_id IS NULL 行由应用层容忍（推荐记录允许重复），
 *   带 work_id 的行仍受上述局部唯一索引兜底保护。
 */
async function bulkUpsert(rows: UsageRow[]): Promise<void> {
  if (rows.length === 0) return
  const admin = getServiceClient()
  if (!admin) {
    console.warn('[usageWriter] getServiceClient 返回 null（未配置 service_role key？），静默跳过 material_usages 写入')
    return
  }

  // 同批次内按业务键去重并合并布尔列（true 覆盖），避免同一条被重复 insert
  const merged = new Map<string, UsageRow>()
  for (const r of rows) {
    const k = usageKey(r)
    const prev = merged.get(k)
    if (!prev) {
      merged.set(k, { ...r })
      continue
    }
    if (r.suggested_by_ai) prev.suggested_by_ai = true
    if (r.selected_by_user) prev.selected_by_user = true
    if (r.actually_used) prev.actually_used = true
  }
  const targets = Array.from(merged.values())

  try {
    // 1) 查已有行：work_id 为空必须用 .is.null（.eq.null 在 PostgREST 里不成立）
    const conditions = Array.from(
      new Set(
        targets.map((r) =>
          r.work_id == null
            ? `and(user_id.eq.${r.user_id},material_id.eq.${r.material_id},work_id.is.null)`
            : `and(user_id.eq.${r.user_id},material_id.eq.${r.material_id},work_id.eq.${r.work_id})`
        )
      )
    )
    const { data: existing, error: selErr } = await admin
      .from('material_usages')
      .select('id,user_id,material_id,work_id')
      .or(conditions.join(','))

    if (selErr) {
      console.warn('[usageWriter] material_usages 查询已有记录失败:', selErr.message)
      return
    }

    const idByKey = new Map<string, string>()
    for (const row of (existing ?? []) as {
      id: string
      user_id: string
      material_id: string
      work_id: string | null
    }[]) {
      idByKey.set(usageKey(row), row.id)
    }

    // 2) 分流：命中 update、未命中 insert
    const inserts: UsageRow[] = []
    const updates: { id: string; patch: Record<string, boolean> }[] = []
    for (const r of targets) {
      const id = idByKey.get(usageKey(r))
      if (!id) {
        inserts.push(r)
        continue
      }
      const patch = flagPatch(r)
      if (Object.keys(patch).length > 0) updates.push({ id, patch })
    }

    if (inserts.length > 0) {
      const { error } = await admin.from('material_usages').insert(inserts)
      if (error) console.warn('[usageWriter] material_usages 插入失败:', error.message)
    }

    await Promise.all(
      updates.map(async ({ id, patch }) => {
        const { error } = await admin.from('material_usages').update(patch).eq('id', id)
        if (error) console.warn('[usageWriter] material_usages 更新失败:', error.message)
      })
    )
  } catch (e) {
    console.warn('[usageWriter] material_usages 写入异常:', e)
  }
}

/**
 * retrieve API 返回 AI 推荐列表后调用。
 * 为自动召回项 UPSERT suggested_by_ai=true；work_id=null（推荐还没关联到作品）。
 * manual 模式不调 retrieve → 这条不会被调用。
 */
export async function recordSuggestedByAi(
  userId: string,
  materialIds: string[]
): Promise<void> {
  if (!userId || materialIds.length === 0) return
  const rows: UsageRow[] = materialIds.map((mid) => ({
    user_id: userId,
    material_id: mid,
    work_id: null,
    suggested_by_ai: true,
  }))
  await bulkUpsert(rows)
}

/**
 * prompt-optimizer 收到 selectedMaterialIds 后调用。
 * 标记 selected_by_user=true（manual/AI 推荐确认两种模式都会传 selectedIds）。
 */
export async function markSelectedByUser(
  userId: string,
  workId: string,
  materialIds: string[]
): Promise<void> {
  if (!userId || !workId || materialIds.length === 0) return
  const rows: UsageRow[] = materialIds.map((mid) => ({
    user_id: userId,
    material_id: mid,
    work_id: workId,
    selected_by_user: true,
  }))
  await bulkUpsert(rows)
}

/**
 * prompt-optimizer 生成成功后调用。
 * 标记 actually_used=true + 回填 work_id（这些素材真正进入了 prompt）。
 * 自动召回项（selected_by_user=false）也会被标记 actually_used。
 */
export async function markActuallyUsed(
  userId: string,
  workId: string,
  materialIds: string[]
): Promise<void> {
  if (!userId || !workId || materialIds.length === 0) return
  const rows: UsageRow[] = materialIds.map((mid) => ({
    user_id: userId,
    material_id: mid,
    work_id: workId,
    actually_used: true,
  }))
  await bulkUpsert(rows)
}
