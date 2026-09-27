#!/usr/bin/env node
// ============================================================
// 数据库备份脚本
//
// 两种模式，自动选择：
//   1) pg_dump 模式（首选）——需要 SUPABASE_DB_URL 且本机装有 pg_dump。
//      产出 .sql.gz，可直接 psql 恢复，包含结构 + 数据 + 约束，最完整。
//   2) REST 快照模式（兜底）——只需 NEXT_PUBLIC_SUPABASE_URL +
//      SUPABASE_SERVICE_ROLE_KEY，用 service_role 逐表分页导出 JSON。
//      产出 .json.gz，配 scripts/restore-db.mjs 使用。
//      不需要安装任何 PostgreSQL 客户端，Windows 上开箱即用。
//
// 为什么必须有它：Supabase 免费版不提供 PITR 与每日备份，
// 一次误操作（delete/update 忘带 where）就是不可逆的全量丢失。
// 这是目前项目最大的单点风险。
//
// 用法：
//   node scripts/backup-db.mjs                  # 自动选模式，输出到 ./backups
//   node scripts/backup-db.mjs --mode=rest      # 强制 REST 模式
//   node scripts/backup-db.mjs --out-dir=D:\bak # 指定输出目录
//   node scripts/backup-db.mjs --keep=30        # 只保留最近 30 份
//
// 环境变量（写在 .env.local 即可，本脚本会自动加载）：
//   NEXT_PUBLIC_SUPABASE_URL       https://xxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY      service_role key（绕过 RLS，务必只放本地/服务端）
//   SUPABASE_DB_URL                postgresql://postgres.xxx:PASSWORD@aws-0-xx.pooler.supabase.com:6543/postgres
// ============================================================

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

// ── 需要备份的表 ──────────────────────────────────────────
// 来源：supabase/setup.sql 与 supabase/migrations/*.sql。
// ⚠ 新增表时必须同步这里，否则该表不会被快照覆盖。
//   对照方式：grep "^create table" supabase/setup.sql supabase/migrations/*.sql
const TABLES = [
  'scripts',
  'generation_history',
  'generation_feedback',
  'style_profiles',
  'creative_projects',
  'posts',
  'post_interactions',
  'comments',
  'follows',
  'user_style_matches',
  'user_characters',
  'user_balances',
  'point_config',
  'point_ledger',
  'payment_settings',
  'recharge_orders',
  'admin_users',
  'ci_items',
  'ci_search_log',
  'creator_events',
  'interest_builds',
  'interest_clusters',
  'interest_suggestions',
  'creator_knowledge',
  'creator_knowledge_links',
  'material_groups',
  'material_usages',
  'work_agent_sessions',
  'work_agent_messages',
]

/**
 * 单页行数。刻意小于 PostgREST 上限 1000：
 * generation_history / interest_clusters 这类表带 1024 维向量列和长正文，
 * 满页 1000 行的响应体过大，实测会在 60s 内传不完而超时（已被真实演练验证）。
 * 减半后单页传输时间显著下降，代价只是多几次往返。
 */
const PAGE_SIZE = 500
/** 单个表最多导出行数，防止失控（100 万行足够中小项目） */
const MAX_ROWS_PER_TABLE = 1_000_000
/** 单次 HTTP 超时：大表单页确实需要更久，宁可慢也不让备份静默失败 */
const FETCH_TIMEOUT_MS = 120_000
/** 单页最大重试次数（网络抖动 / 连接池瞬时打满） */
const MAX_RETRIES = 2

// ── 环境变量加载（Node 不会自动读 .env.local）────────────
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
      // 去掉成对引号
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      // 已存在的环境变量优先（命令行/CI 注入的更高优先级）
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

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ── 模式一：pg_dump ─────────────────────────────────────
function pgDumpAvailable() {
  try {
    const r = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' })
    return r.status === 0
  } catch {
    return false
  }
}

async function backupWithPgDump(dbUrl, outFile) {
  const { createWriteStream } = await import('node:fs')
  const { createGzip } = await import('node:zlib')
  const { spawn } = await import('node:child_process')

  // pg_dump 的自定义格式（-Fc）比纯 SQL 更紧凑，且支持选择性恢复
  const child = spawn('pg_dump', [dbUrl, '--format=custom', '--no-owner', '--no-acl'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  child.stderr.on('data', (c) => {
    stderr += c.toString()
  })

  await pipeline(child.stdout, createGzip(), createWriteStream(outFile))

  const code = await new Promise((res) => child.on('close', res))
  if (code !== 0) {
    throw new Error(`pg_dump 退出码 ${code}: ${stderr.slice(0, 500)}`)
  }
}

// ── 模式二：REST 快照 ────────────────────────────────────
/**
 * 拉取一页。带重试：备份是批处理任务，一次网络抖动不该让整张表丢失。
 * 只重试"可恢复"的失败（超时/网络/5xx）；403 缺权限这类重试一万次也没用，
 * 直接抛出，让上层记录成明确错误。
 */
async function fetchPage(baseUrl, serviceKey, table, start, end) {
  let lastError = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // 退避：1s、2s
      await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
    try {
      const res = await fetch(`${baseUrl}/rest/v1/${table}?select=*`, {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          // Range 用半开区间语义：0-499 表示第 1~500 行
          Range: `${start}-${end}`,
          'Range-Unit': 'items',
          'Accept-Encoding': 'gzip',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        // 4xx（缺权限 / 表不存在）不可重试，立即失败并带上原因
        if (res.status < 500) {
          throw new Error(`${table}: HTTP ${res.status} ${text.slice(0, 200)}`)
        }
        lastError = new Error(`${table}: HTTP ${res.status} ${text.slice(0, 200)}`)
        continue
      }

      return await res.json()
    } catch (e) {
      if (e instanceof Error && /HTTP \d{3}/.test(e.message)) throw e
      lastError = e
    }
  }

  throw lastError ?? new Error(`${table}: 未知失败`)
}

async function dumpTable(baseUrl, serviceKey, table) {
  const rows = []
  for (let start = 0; start < MAX_ROWS_PER_TABLE; start += PAGE_SIZE) {
    const page = await fetchPage(baseUrl, serviceKey, table, start, start + PAGE_SIZE - 1)
    if (!Array.isArray(page)) throw new Error(`${table}: 返回格式异常`)
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return rows
}

async function backupWithRest(baseUrl, serviceKey, outFile) {
  const snapshot = {
    meta: {
      exportedAt: new Date().toISOString(),
      source: baseUrl,
      mode: 'rest',
      tableCount: TABLES.length,
      // 恢复脚本据此校验兼容性
      formatVersion: 1,
    },
    tables: {},
  }

  let total = 0
  for (const table of TABLES) {
    try {
      const rows = await dumpTable(baseUrl, serviceKey, table)
      snapshot.tables[table] = rows
      total += rows.length
      console.log(`  ✓ ${table.padEnd(28)} ${rows.length} 行`)
    } catch (e) {
      // 单表失败不中断整体：缺表（迁移未执行）是最常见的失败原因，
      // 让其它表照常导出，比整份备份失败有价值得多。
      snapshot.tables[table] = { error: e instanceof Error ? e.message : String(e) }
      console.warn(`  ✗ ${table.padEnd(28)} 失败：${e instanceof Error ? e.message : e}`)
    }
  }

  snapshot.meta.rowCount = total
  writeFileSync(outFile.replace(/\.gz$/, ''), JSON.stringify(snapshot))
  return total
}

// ── 保留策略 ────────────────────────────────────────────
function pruneOldBackups(dir, keep) {
  if (keep <= 0) return
  const files = readdirSync(dir)
    .filter((f) => /^db-\d{8}-\d{6}\.(json|sql)(\.gz)?$/.test(f))
    .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  for (const f of files.slice(keep)) {
    rmSync(join(dir, f.name), { force: true })
    console.log(`  · 已清理旧备份 ${f.name}`)
  }
}

// ── 主流程 ──────────────────────────────────────────────
async function main() {
  loadEnvFiles()

  const outDir = resolve(arg('out-dir', 'backups'))
  const keep = Number(arg('keep', '30'))
  const mode = arg('mode', 'auto')
  const stamp = timestamp()
  mkdirSync(outDir, { recursive: true })

  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  const dbUrl = process.env.SUPABASE_DB_URL?.trim()

  let usedMode = null

  if (mode !== 'rest' && dbUrl && pgDumpAvailable()) {
    const outFile = join(outDir, `db-${stamp}.sql.gz`)
    console.log(`[pg_dump] 备份到 ${outFile}`)
    await backupWithPgDump(dbUrl, outFile)
    usedMode = 'pg_dump'
    console.log(`✓ 完成（${(statSync(outFile).size / 1024 / 1024).toFixed(2)} MB）`)
  } else {
    if (!baseUrl || !serviceKey) {
      console.error(
        '✗ 缺少配置：REST 备份需要 NEXT_PUBLIC_SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY；\n' +
          '  也可配置 SUPABASE_DB_URL 并安装 pg_dump 走物理备份。'
      )
      process.exit(1)
    }
    if (mode !== 'rest') {
      console.log('· 未检测到可用的 pg_dump，回落到 REST 快照模式')
    }
    const jsonFile = join(outDir, `db-${stamp}.json`)
    console.log(`[REST] 备份 ${TABLES.length} 张表到 ${jsonFile}.gz`)
    const total = await backupWithRest(baseUrl, serviceKey, jsonFile)
    // 压缩后再删除明文，避免中途失败留下半份文件
    const gz = gzipSync(readFileSync(jsonFile))
    writeFileSync(`${jsonFile}.gz`, gz)
    rmSync(jsonFile, { force: true })
    usedMode = 'rest'
    console.log(
      `✓ 完成：共 ${total} 行，压缩后 ${(gz.length / 1024 / 1024).toFixed(2)} MB → ${basename(jsonFile)}.gz`
    )
  }

  console.log(`\n保留最近 ${keep} 份：`)
  pruneOldBackups(outDir, Number.isFinite(keep) ? keep : 30)

  console.log(`\n备份模式：${usedMode}`)
  console.log('提示：把备份同步到另一处（对象存储/移动硬盘），只留在本机不算备份。')
}

main().catch((e) => {
  console.error('备份失败：', e)
  process.exit(1)
})
