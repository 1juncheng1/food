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
//   - UPSERT 用 (user_id, material_id) 唯一键，幂等防止重复写入
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

/**
 * 批量 upsert：按 (user_id, material_id, work_id) 冲突键更新我们传了的列。
 * 不传的列保持原值（靠 Supabase upsert 默认行为：只 UPDATE EXCLUDED 里出现的列）。
 * 对应 setup.sql 第 17.4 节的局部唯一约束：
 *   material_usages_user_material_work_uniq ON (user_id, material_id, work_id) WHERE work_id IS NOT NULL
 * work_id IS NULL 的记录（推荐但未关联作品）因约束 WHERE 条件不匹配，
 * PostgreSQL 的 ON CONFLICT 找不到匹配项，行为退化为 INSERT（每次推荐一行）——这是预期。
 */
async function bulkUpsert(rows: UsageRow[]): Promise<void> {
  if (rows.length === 0) return
  const admin = getServiceClient()
  if (!admin) {
    console.warn('[usageWriter] getServiceClient 返回 null（未配置 service_role key？），静默跳过 material_usages 写入')
    return
  }
  try {
    const { error } = await admin
      .from('material_usages')
      .upsert(rows, {
        onConflict: 'user_id, material_id, work_id',
      })
    if (error) {
      console.warn('[usageWriter] material_usages 写入失败:', error.message)
    }
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
