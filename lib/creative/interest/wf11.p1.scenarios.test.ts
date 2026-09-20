// ============================================================
// WF11 P1：抖音式灵感无限流 —— 远程真实链路收口验证
//
// 默认跳过（日常 npm test 零影响、零远程调用、零 LLM/搜索花费）。
//
// 标准运行命令（Windows PowerShell）：
//   Get-Content .env.local | ForEach-Object {
//     if ($_ -match '^([A-Z_]+)=(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
//   }; $env:WF11_REMOTE='1'; $env:NODE_OPTIONS='--dns-result-order=ipv4first'; npx vitest run lib/creative/interest/wf11.p1.scenarios.test.ts
//
// 注意：必须设 NODE_OPTIONS=--dns-result-order=ipv4first，否则 Node.js undici
// 默认尝试 IPv6 连接 Supabase Cloudflare 边缘节点会 10s 超时（IPv6 路由不通）。
//
// 会真实消耗：Tavily（6 类串行摄取）+ DeepSeek（S4 批量 16 + AI 理由 + 簇命名）。
//
// T1 全局热点冷启动（AC-1）：
//   首次 ingest ∈ ingested/skipped（当天可能已被懒触发跑过）→ 当日 global hash 库存 ≥12
//   → 第二次严格 skipped（日闸门幂等）→ reader 出 3 张脱敏卡
// T2 多兴趣广度（AC-2/AC-3）：
//   临时注册用户落 2 个方向各 3 条 work_generate（每方向近复述，稳超聚类阈值）
//   → full build → active 队列 ≥20、簇覆盖 ≥2、≥1 张 cross_exploration=true
//   → afterAll admin 删除临时用户（级联清数据）
// ============================================================

import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// ── vitest 不加载 .env.local：手动注入（仅远程场景测试需要） ──
const envPath = path.resolve(__dirname, '../../../.env.local')
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

import { getServiceClient } from '../../ci/store'
import { ingestGlobalTrending, getGlobalTrending, globalHashFor, GLOBAL_TRENDING_FRESH_MIN } from '../../ci/globalTrending'
import { trackEvent } from './eventTracker'
import { runBuild } from './builder'
import { getActiveSuggestions } from './suggestionRepo'
import { fetchActiveClusters } from './interestRepo'

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

// 每方向 3 条近复述主题：聚类继承阈值 0.72 + CLUSTER_MIN_MEMBERS=2（WF9 实测泛子话题
// 会裂成单成员簇被滤掉），近复述保证每方向稳定成簇；两个方向语义刻意拉远保证 ≥2 簇。
const DIR_A = [
  'WF11P1 摆摊卖小吃怎么起步和选址',
  'WF11P1 摆摊卖小吃起步选址技巧',
  'WF11P1 摆摊小吃怎么起步与选址',
]
const DIR_B = [
  'WF11P1 大模型私有化部署方案',
  'WF11P1 大模型私有化怎么部署',
  'WF11P1 大模型私有化部署实践',
]

function svc() {
  const c = getServiceClient()
  if (!c) throw new Error('SUPABASE_SERVICE_ROLE_KEY 未配置（远程场景测试必需）')
  return c
}

/** GoTrue 注册临时用户：access_token 在扁平响应顶层，userId 从 JWT payload.sub 解 */
async function signupTempUser(): Promise<{ userId: string; email: string }> {
  const email = `wf11p1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
  const res = await fetch(`${SUPA_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ email, password: 'Wf11P1-Test-2026' }),
  })
  const body = await res.json()
  if (!body?.access_token) {
    throw new Error(`临时用户注册失败（可能需关闭邮箱确认）: ${JSON.stringify(body)}`)
  }
  // JWT payload 解码口径：header.payload.signature，payload base64url → JSON.sub
  const payload = JSON.parse(Buffer.from(String(body.access_token).split('.')[1], 'base64url').toString())
  return { userId: payload.sub as string, email }
}

/** admin API 删用户：依赖 setup.sql 的 ON DELETE CASCADE 清 creator_events/interest_* */
async function deleteTempUser(userId: string): Promise<number> {
  const res = await fetch(`${SUPA_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  return res.status
}

// 允许远程跑：T1 串行 6 类搜索 + T2 完整 build（embedding + 多次 LLM）
const t = describe.skipIf(!process.env.WF11_REMOTE)

t('WF11 P1 远程真实链路', () => {
  let tempUserId: string | null = null

  afterAll(async () => {
    if (tempUserId) {
      const status = await deleteTempUser(tempUserId).catch((e) => {
        console.warn('[WF11P1] 临时用户清理失败，需人工删除:', tempUserId, e)
        return 0
      })
      console.info(`[WF11P1] 临时用户 ${tempUserId} 删除 HTTP ${status}`)
    }
  })

  it('T1: 全局热点摄取幂等 + reader 出卡（AC-1）', async () => {
    const first = await ingestGlobalTrending()
    // 当天可能已被 inspirations 接口懒触发跑过：两态都合法，failed/locked 不合法
    expect(['ingested', 'skipped']).toContain(first)
    console.info(`[WF11P1-T1] 首次 ingest = ${first}`)

    // 当日 global hash 下有效 ci_items ≥ 日闸门阈值（否则 reader 无库存，冷启动回退模板）
    const hash = globalHashFor()
    const { data: rows, error } = await svc()
      .from('ci_items')
      .select('id')
      .eq('query_hash', hash)
      .gt('expires_at', new Date().toISOString())
    expect(error).toBeNull()
    expect((rows ?? []).length).toBeGreaterThanOrEqual(GLOBAL_TRENDING_FRESH_MIN)

    // 第二次必须被日闸门拦截（幂等：不重复打 Tavily）
    const second = await ingestGlobalTrending()
    expect(second).toBe('skipped')

    const cards = await getGlobalTrending(3)
    expect(cards).toHaveLength(3)
    // 脱敏卡口径：标题/描述/类别齐全，不回显 query_hash/ai_analysis 等内部字段
    for (const c of cards) {
      expect(c.title.length).toBeGreaterThan(0)
      expect(c.description.length).toBeGreaterThan(0)
      expect(c.category.length).toBeGreaterThan(0)
      expect(c).not.toHaveProperty('query_hash')
      expect(c).not.toHaveProperty('ai_analysis')
    }
    console.info(`[WF11P1-T1] 热点卡：${cards.map((c) => c.title).join(' / ')}`)
  }, 600_000)

  it('T2: 两方向各 3 篇 → 队列 ≥20、簇覆盖 ≥2、跨簇卡 ≥1（AC-2/AC-3）', async () => {
    const client = svc()
    const { userId } = await signupTempUser()
    tempUserId = userId
    console.info(`[WF11P1-T2] 临时用户 ${userId}`)

    const topics = [...DIR_A, ...DIR_B]
    for (let i = 0; i < topics.length; i++) {
      const r = await trackEvent(client, userId, {
        type: 'work_generate',
        targetType: 'generation',
        targetId: `WF11P1-gen-${i}`,
        topicExcerpt: topics[i],
        category: null,
        contentDomain: null,
      })
      expect(r.ok).toBe(true)
    }

    const build = await runBuild(client, userId, 'full')
    expect(build.status).toBe('done')

    // 多兴趣建模先成立：两个方向各自成簇
    const clusters = await fetchActiveClusters(client, userId)
    console.info(
      `[WF11P1-T2] active 簇 ${clusters.length} 个：${clusters.map((c) => c.label).join(' / ')}`,
    )
    expect(clusters.length).toBeGreaterThanOrEqual(2)

    // 队列供给量：S4 扩批 16 + 其他源，active 必须 ≥20（无限流供给基础）
    const queue = await getActiveSuggestions(client, userId, 30)
    console.info(`[WF11P1-T2] active 队列 ${queue.length} 张`)
    expect(queue.length).toBeGreaterThanOrEqual(20)

    // evidence 证据包验收
    const ev = queue.map((r) => (r as { evidence?: Record<string, unknown> }).evidence ?? {})
    const labels = [...new Set(ev.map((e) => e.cluster_label).filter((x): x is string => typeof x === 'string'))]
    const crossCount = ev.filter((e) => e.cross_exploration === true).length
    console.info(
      `[WF11P1-T2] evidence 簇覆盖 ${labels.length} 个（${labels.join(' / ')}），cross_exploration ${crossCount} 张`,
    )
    expect(labels.length).toBeGreaterThanOrEqual(2)
    expect(crossCount).toBeGreaterThanOrEqual(1)
  }, 900_000)
})
