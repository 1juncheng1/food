// ============================================================
// 知识 ↔ 作品 关联（Creator Knowledge System 补链）
//
// 表结构见 supabase/migrations/0011_knowledge_work_links.sql。
//
// 与 0006 的 used_knowledge 快照分工：
//   used_knowledge     = 某个版本「当时注入了哪些概念」的事实快照（只读历史）
//   knowledge_links    = 「这条知识现在属于哪些作品」的当前指针（可被用户增删）
// 不要把两者合并：历史快照被当前状态改写，是 0006 刻意避免的事。
//
// 这里只做读取侧的公共搬运（列表页要一次拿 N 条单元的关联，详情接口只要一条），
// 写入侧的归属校验放在各自的路由里 —— 谁能改什么，属于鉴权语义，不该藏在工具函数里。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type KnowledgeLinkOrigin = 'manual' | 'auto_history'

/** 一条「知识单元 → 作品」的关联（含作品侧的最小展示信息） */
export interface LinkedWork {
  projectId: string
  title: string
  topic: string
  status: string
  updatedAt: string
  /** 关联建立时间：手动关联与历史回填都算数，用于排序与展示 */
  linkedAt: string
  origin: KnowledgeLinkOrigin
}

export type LinkedWorksResult =
  | { ok: true; links: Record<string, LinkedWork[]> }
  | { ok: false; reason: 'missing-migration' | 'error'; message?: string }

export const LINKS_MIGRATION_HINT =
  '知识关联表尚未初始化，请先执行 supabase/migrations/0011_knowledge_work_links.sql'

/** 表不存在；PostgREST/Postgres 两种"函数/关系找不到"的码都算迁移没跑 */
export function isMissingMigrationError(error: unknown): boolean {
  const code = (error as { code?: string } | null | undefined)?.code
  return code === '42P01' || code === '42883' || code === 'PGRST202'
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

/**
 * 一次取多条知识单元的关联作品。
 *
 * 刻意不用 PostgREST 的嵌套 select（creator_knowledge_links → creative_projects）：
 *   1. 嵌套依赖 PostgREST 关系缓存，DDL 后短时间内可能还没刷新
 *   2. 显式二次查询才能加上 user_id 过滤，不把"只看得见自己的作品"寄托给 RLS 兜底
 */
export async function loadLinkedWorks(
  supabase: SupabaseClient,
  userId: string,
  knowledgeIds: string[]
): Promise<LinkedWorksResult> {
  if (knowledgeIds.length === 0) return { ok: true, links: {} }

  const { data: linkRows, error: linkErr } = await supabase
    .from('creator_knowledge_links')
    .select('knowledge_id, project_id, origin, created_at')
    .eq('user_id', userId)
    .in('knowledge_id', knowledgeIds)

  if (linkErr) {
    return isMissingMigrationError(linkErr)
      ? { ok: false, reason: 'missing-migration' }
      : { ok: false, reason: 'error', message: linkErr.message }
  }

  const rows = linkRows ?? []
  const projectIds = Array.from(
    new Set(rows.map((r) => str((r as { project_id?: unknown }).project_id)).filter(Boolean))
  )

  const projectMeta = new Map<string, { title: string; topic: string; status: string; updatedAt: string }>()
  if (projectIds.length > 0) {
    const { data: projects, error: projErr } = await supabase
      .from('creative_projects')
      .select('id, title, topic, status, updated_at')
      .eq('user_id', userId)
      .in('id', projectIds)

    // 作品表不可能缺（setup.sql 就有），这里失败就是真失败
    if (projErr) {
      return { ok: false, reason: 'error', message: projErr.message }
    }

    for (const p of projects ?? []) {
      const id = str((p as { id?: unknown }).id)
      if (!id) continue
      projectMeta.set(id, {
        title: str((p as { title?: unknown }).title) || str((p as { topic?: unknown }).topic) || '未命名作品',
        topic: str((p as { topic?: unknown }).topic),
        status: str((p as { status?: unknown }).status, 'active'),
        updatedAt: str((p as { updated_at?: unknown }).updated_at),
      })
    }
  }

  const links: Record<string, LinkedWork[]> = {}
  for (const row of rows) {
    const o = row as Record<string, unknown>
    const knowledgeId = str(o.knowledge_id)
    const projectId = str(o.project_id)
    if (!knowledgeId || !projectId) continue
    // 作品被删掉后可能残留孤儿行（并发删除窗口）：查不到就不展示，不抛错
    const meta = projectMeta.get(projectId)
    if (!meta) continue

    const list = links[knowledgeId] ?? []
    list.push({
      projectId,
      title: meta.title,
      topic: meta.topic,
      status: meta.status,
      updatedAt: meta.updatedAt,
      linkedAt: str(o.created_at),
      origin: o.origin === 'auto_history' ? 'auto_history' : 'manual',
    })
    links[knowledgeId] = list
  }

  // 最近更新过的作品排前面：用户关心的是"它现在还在用吗"
  for (const list of Object.values(links)) {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  return { ok: true, links }
}
