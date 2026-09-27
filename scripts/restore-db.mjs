#!/usr/bin/env node
// ============================================================
// 数据库恢复脚本（配合 scripts/backup-db.mjs 的 REST 快照）
//
// 两种模式：
//   merge（默认，安全）：按主键 upsert。已存在的行被覆盖成备份里的值，
//                        备份里没有的行**保持不动**。适合"误删了几条/改错了几行"。
//   replace（危险）：先清空整张表再灌入备份数据，目标库最终与快照完全一致。
//                    必须显式 --force，用于"恢复到空库/整体回滚"。
//
// 为什么默认不做 replace：
//   误操作之后最常发生的二次事故，就是"为了找回 3 条数据把整表清空了"。
//   merge 是幂等的、可重复执行的，代价只是不会清理备份之后新增的行。
//
// 用法：
//   node scripts/restore-db.mjs backups/db-20260927-120000.json.gz
//   node scripts/restore-db.mjs <文件> --tables=posts,comments   # 只恢复指定表
//   node scripts/restore-db.mjs <文件> --dry-run                 # 只打印将要做的事
//   node scripts/restore-db.mjs <文件> --mode=replace --force
//
// ⚠ 恢复前请务必先跑一份当前库的新备份（--mode=rest），给回滚留后路。
// ============================================================

import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'

/** 各表主键，PostgREST upsert 需要显式指定冲突列 */
const PRIMARY_KEYS = {
  scripts: 'id',
  generation_history: 'id',
  generation_feedback: 'id',
  style_profiles: 'user_id',
  creative_projects: 'id',
  posts: 'id',
  post_interactions: 'id',
  comments: 'id',
  follows: 'id',
  user_style_matches: 'id',
  user_characters: 'id',
  user_balances: 'user_id',
  point_config: 'key',
  point_ledger: 'id',
  payment_settings: 'id',
  recharge_orders: 'id',
  admin_users: 'user_id',
  ci_items: 'id',
  ci_search_log: 'id',
  creator_events: 'id',
  interest_builds: 'id',
  interest_clusters: 'id',
  interest_suggestions: 'id',
  creator_knowledge: 'id',
  creator_knowledge_links: 'id',
  material_groups: 'id',
  material_usages: 'id',
  work_agent_sessions: 'id',
  work_agent_messages: 'id',
}

/** replace 模式下的删除顺序：先删引用方，再删被引用方 */
const DELETE_ORDER = [
  'generation_feedback',
  'point_ledger',
  'recharge_orders',
  'creator_knowledge_links',
  'material_usages',
  'work_agent_messages',
  'work_agent_sessions',
  'interest_suggestions',
  'interest_clusters',
  'interest_builds',
  'creator_events',
  'creator_knowledge',
  'ci_search_log',
  'ci_items',
  'post_interactions',
  'comments',
  'posts',
  'follows',
  'material_groups',
  'user_style_matches',
  'user_characters',
  'generation_history',
  'creative_projects',
  'scripts',
  'admin_users',
  'user_balances',
  'style_profiles',
  'payment_settings',
  'point_config',
]

/** upsert 分批大小：单批太大容易被 PostgREST 拒绝或超时 */
const BATCH_SIZE = 500
/**
 * 单次 HTTP 超时：generation_history 这类表带 1024 维向量与长正文，
 * 单批写入耗时远超普通表，60s 实测不够，放宽到 120s。
 */
const FETCH_TIMEOUT_MS = 120_000

function loadEnvFiles() {
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = value
    }
  }
}

function arg(name, fallback) {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

async function postgrest(path, { method, body, headers = {} }) {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  const res = await fetch(`${baseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  return res
}

async function main() {
  loadEnvFiles()

  const file = process.argv.find((a) => !a.startsWith('--') && !a.endsWith('.mjs') && !a.endsWith('node'))
  if (!file) {
    console.error('用法：node scripts/restore-db.mjs <备份文件.json.gz>')
    process.exit(1)
  }

  const target = resolve(file)
  if (!existsSync(target)) {
    console.error(`✗ 文件不存在：${target}`)
    process.exit(1)
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('✗ 缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }

  const dryRun = hasFlag('dry-run')
  const mode = arg('mode', 'merge')
  const force = hasFlag('force')
  const onlyTables = arg('tables', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (mode === 'replace' && !force) {
    console.error(
      '✗ replace 模式会先清空整表，请确认无误后追加 --force。\n' +
        '  只想找回误删的几行数据？用默认的 merge 模式即可。'
    )
    process.exit(1)
  }

  // ── 读取快照 ──
  const raw = readFileSync(target)
  const json = target.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
  const snapshot = JSON.parse(json)

  if (snapshot?.meta?.formatVersion !== 1) {
    console.error('✗ 无法识别的备份格式（formatVersion 不是 1）')
    process.exit(1)
  }

  const tables = Object.keys(snapshot.tables ?? {}).filter(
    (t) => (onlyTables.length === 0 || onlyTables.includes(t)) && Array.isArray(snapshot.tables[t])
  )

  console.log(`备份时间：${snapshot.meta.exportedAt}`)
  console.log(`模式：${mode}${dryRun ? '（dry-run，不会写入）' : ''}`)
  console.log(`将恢复 ${tables.length} 张表\n`)

  if (dryRun) {
    for (const t of tables) console.log(`  · ${t.padEnd(28)} ${snapshot.tables[t].length} 行`)
    return
  }

  // ── replace：先按依赖顺序清空 ──
  if (mode === 'replace') {
    for (const t of DELETE_ORDER) {
      if (!tables.includes(t)) continue
      try {
        // id=not.is.null 是恒真条件：PostgREST 不允许无过滤的 DELETE
        await postgrest(`${t}?id=not.is.null`, { method: 'DELETE' })
        console.log(`  ✓ 已清空 ${t}`)
      } catch (e) {
        console.warn(`  ✗ 清空 ${t} 失败：${e.message}`)
      }
    }
  }

  // ── 灌数据 ──
  let total = 0
  for (const t of tables) {
    const rows = snapshot.tables[t]
    if (rows.length === 0) {
      console.log(`  · ${t.padEnd(28)} 0 行，跳过`)
      continue
    }

    const pk = PRIMARY_KEYS[t]
    if (!pk) {
      console.warn(`  ✗ ${t.padEnd(28)} 未登记主键，跳过（请在 PRIMARY_KEYS 中补充）`)
      continue
    }

    let written = 0
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      try {
        await postgrest(t, {
          method: 'POST',
          body: batch,
          headers: {
            // 主键冲突时更新，而不是整批失败
            Prefer: `resolution=merge-duplicates,on_conflict=${pk}`,
          },
        })
        written += batch.length
      } catch (e) {
        console.warn(`  ✗ ${t} 第 ${i / BATCH_SIZE + 1} 批失败：${e.message}`)
      }
    }
    total += written
    console.log(`  ✓ ${t.padEnd(28)} ${written}/${rows.length} 行`)
  }

  console.log(`\n恢复完成，共写入 ${total} 行。`)
  if (mode === 'merge') {
    console.log('注意：merge 模式不会删除备份之后新增的行。若需完全一致，请用 --mode=replace --force。')
  }
}

main().catch((e) => {
  console.error('恢复失败：', e)
  process.exit(1)
})
