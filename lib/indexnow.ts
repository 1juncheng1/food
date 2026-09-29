import { PUBLIC_PATHS, SITE_URL, absoluteUrl } from '@/lib/seo'

// ────────────────────────────────────────────────────────────
// IndexNow —— Bing / Edge / Yandex / Seznam 共同支持的「即时索引推送」协议
//
// Edge 地址栏的搜索结果来自 Bing 索引，所以对 Edge 而言这是性价比最高的一步：
// 传统做法是「把 URL 放进 sitemap，等搜索引擎自己来爬」，周期不定；
// IndexNow 是「内容一变就主动敲门」，Bing 通常在几分钟内抓取。
//
// 协议极简，一次 POST 就够：
//   POST https://api.indexnow.org/indexnow
//   { host, key, keyLocation, urlList }
//
// 三条硬约束（违反会让整个 key 被判为垃圾提交）：
//   1. key 文件必须能通过 https 公开访问：https://域名/<key>.txt，内容 = key 本身
//   2. 只推「无需登录、可被抓取、且 robots 未禁止」的 URL
//      —— 推登录墙页面 = 主动告诉 Bing「这个站点提交垃圾」
//   3. 单次最多 10000 个 URL，请求体 < 1MB
//
// 失败必须静默：SEO 是旁路功能，绝不能因为它把发布主流程拖垮或打断。
// ────────────────────────────────────────────────────────────

/** IndexNow 官方聚合端点，会自动分发给 Bing / Yandex / Seznam 等参与方 */
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'
/** 单批上限（协议规定 10000） */
const MAX_URLS_PER_REQUEST = 10_000
/** 超时预算：宁可放弃这次推送，也不能占用请求线程 */
const TIMEOUT_MS = 5_000

export type IndexNowResult = {
  ok: boolean
  submitted: number
  /** 失败或未配置的原因，便于排查，不抛给调用方 */
  reason?: string
}

/** 站点域名（协议要求不带协议前缀） */
function siteHost(): string {
  return SITE_URL.replace(/^https?:\/\//i, '')
}

/**
 * 过滤出「可以安全推送」的 URL：
 *   - 补全为绝对地址
 *   - 只保留本站域名（防止误把第三方链接推出去）
 *   - 去重
 */
function normalizeUrls(urls: readonly string[]): string[] {
  const host = siteHost()
  const seen = new Set<string>()

  for (const raw of urls) {
    let url = absoluteUrl(raw)
    try {
      const parsed = new URL(url)
      if (parsed.host !== host) continue
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue
      url = `${parsed.origin}${parsed.pathname}`
    } catch {
      continue
    }
    seen.add(url)
  }

  return [...seen].slice(0, MAX_URLS_PER_REQUEST)
}

/**
 * 把 URL 推送给 IndexNow（Bing / Edge）。
 *
 * 未配置 INDEXNOW_KEY 时直接跳过，不报错 —— 本地开发不该因为
 * 少配一个 SEO 变量就产生噪音日志。
 */
export async function submitToIndexNow(urls: readonly string[]): Promise<IndexNowResult> {
  const key = process.env.INDEXNOW_KEY?.trim()
  if (!key) {
    return { ok: false, submitted: 0, reason: '未配置 INDEXNOW_KEY，已跳过推送' }
  }

  const urlList = normalizeUrls(urls)
  if (urlList.length === 0) {
    return { ok: false, submitted: 0, reason: '没有可推送的本站 URL' }
  }

  const body = JSON.stringify({
    host: siteHost(),
    key,
    keyLocation: `${SITE_URL}/${key}.txt`,
    urlList,
  })

  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    // IndexNow 正常返回 200 / 202；4xx 基本都是 key 或 urlList 不合规
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[indexnow] 推送失败 ${res.status} ${detail.slice(0, 200)}`)
      return { ok: false, submitted: 0, reason: `IndexNow 返回 ${res.status}` }
    }

    return { ok: true, submitted: urlList.length }
  } catch (error) {
    // 网络超时/解析失败：记录一次即可，调用方继续走自己的业务逻辑
    console.error('[indexnow] 推送异常:', error instanceof Error ? error.message : error)
    return { ok: false, submitted: 0, reason: '推送请求异常' }
  }
}

/**
 * 推送站点当前全部公开 URL。
 *
 * 清单直接复用 sitemap 的 PUBLIC_PATHS —— 保证「能被抓的」和「推送出去的」
 * 永远是同一份，不会出现 sitemap 里没有却硬推的情况。
 */
export async function submitPublicUrlsToIndexNow(): Promise<IndexNowResult> {
  return submitToIndexNow(PUBLIC_PATHS)
}
