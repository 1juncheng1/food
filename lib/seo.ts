import type { Metadata } from 'next'

// ────────────────────────────────────────────────────────────
// 全站 SEO 唯一配置出口。
//
// 设计原则：
//   - 所有页面标题/描述/canonical/OG/Twitter 标签都从这里生成，
//     避免每个页面各写一套导致口径不一。
//   - 不做关键词堆砌，description 只用人话概括页面内容。
//   - 需要登录的内部页（(main) 路由组）一律 noindex，防止
//     「登录墙页面」进入索引（搜索引擎只能看到空壳，反而降质）。
// ────────────────────────────────────────────────────────────

/**
 * 站点规范域名（必须带协议、不带末尾斜杠）。
 *
 * 优先级：
 *   1. NEXT_PUBLIC_SITE_URL —— 在 .env.local / 部署平台配置，如 https://vision.example.com
 *   2. VERCEL_URL           —— 部署在 Vercel 时自动注入
 *   3. 本地开发兜底          —— http://localhost:3000
 *
 * canonical / og:url / sitemap 都要求绝对地址，这个值错了会连锁污染全站，
 * 上线前务必确认已配置。
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
).replace(/\/+$/, '')

export const SITE_NAME = '视界'
export const SITE_NAME_FULL = '视界 Vision'
export const SITE_DESCRIPTION =
  '视界是一个越来越懂你的 AI 创作伙伴。它理解你的灵感、知识与表达方式，陪伴你把模糊想法变成有依据、有观点、可以真正发布的作品。'

/** 默认分享封面：public/og-cover.png（1200×630，约 154KB） */
export const DEFAULT_OG_IMAGE = '/og-cover.png'
export const LOCALE = 'zh-CN'

/**
 * 当前「无需登录即可完整阅读」的公开路径。
 *
 * sitemap.xml 与 IndexNow 推送共用这一份清单，保证「能被抓的」和「推出去的」
 * 永远是同一批 URL，不会出现 sitemap 里没有却硬推的情况。
 *
 * 新增公开页时只改这里：sitemap 自动出现，IndexNow 自动推送。
 * 同时记得在 app/robots.ts 的 PRIVATE_PREFIXES 里移除对应前缀，
 * 否则 robots 禁止抓取，推了也白推。
 */
export const PUBLIC_PATHS: readonly string[] = ['/']

/** 把站内路径解析成绝对 URL */
export function absoluteUrl(path = '/'): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`
}

/** 描述过长会被搜索引擎截断，统一在这里收口 */
function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

export type PageSeoInput = {
  /** 页面主题（不带品牌后缀，最终渲染为「{title} · 视界」） */
  title: string
  description: string
  /** 规范路径，如 /dashboard */
  path: string
  /** 是否允许收录；需要登录 / 后台页一律 false */
  index?: boolean
  image?: string
  type?: 'website' | 'article'
  publishedTime?: string
  modifiedTime?: string
}

/** 单页元信息生成器：title / description / canonical / robots / OG / Twitter 一次到位 */
export function pageMetadata(input: PageSeoInput): Metadata {
  const { title, description, path, index = true, image = DEFAULT_OG_IMAGE, type = 'website' } = input
  const url = absoluteUrl(path)
  // 标题里已含品牌名就不重复追加（首页整站标题自带「视界」）
  const fullTitle = title.includes(SITE_NAME) ? title : `${title} · ${SITE_NAME}`
  const desc = clamp(description, 160)
  const imageUrl = absoluteUrl(image)

  return {
    title: fullTitle,
    description: desc,
    // 每页指向自己的规范 URL，避免带参数/大小写变体造成重复内容
    alternates: { canonical: url },
    robots: index
      ? {
          index: true,
          follow: true,
          googleBot: {
            index: true,
            follow: true,
            'max-image-preview': 'large',
            'max-snippet': -1,
            'max-video-preview': -1,
          },
        }
      : { index: false, follow: false, googleBot: { index: false, follow: false } },
    openGraph: {
      type,
      url,
      title: fullTitle,
      description: desc,
      siteName: SITE_NAME_FULL,
      locale: LOCALE,
      images: [{ url: imageUrl, width: 1200, height: 630, alt: fullTitle }],
      ...(type === 'article' && input.publishedTime ? { publishedTime: input.publishedTime } : {}),
      ...(type === 'article' && input.modifiedTime ? { modifiedTime: input.modifiedTime } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description: desc,
      images: [imageUrl],
    },
  }
}

/** 需要登录的内部页：统一 noindex + nofollow（标题仍然保留，浏览器标签页与分享预览可用） */
export function appPageMetadata(
  input: Pick<PageSeoInput, 'title' | 'description' | 'path'>
): Metadata {
  return pageMetadata({ ...input, index: false })
}

/**
 * 搜索引擎站点所有权验证 meta。
 *
 * 三个平台各给一段验证码，填进环境变量后 Next 会自动输出对应 <meta>：
 *   google:  <meta name="google-site-verification" content="...">
 *   bing:    <meta name="msvalidate.01" content="...">        ← Edge / Bing
 *   baidu:   <meta name="baidu-site-verification" content="...">
 *
 * 没配置就不输出任何标签（不输出比输出空值干净）。
 */
export function siteVerification(): Metadata['verification'] | undefined {
  const verification: NonNullable<Metadata['verification']> = {}
  const other: Record<string, string> = {}

  const google = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION?.trim()
  const bing = process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION?.trim()
  const baidu = process.env.NEXT_PUBLIC_BAIDU_SITE_VERIFICATION?.trim()

  if (google) verification.google = google
  if (bing) other['msvalidate.01'] = bing
  if (baidu) other['baidu-site-verification'] = baidu
  if (Object.keys(other).length > 0) verification.other = other

  return Object.keys(verification).length > 0 ? verification : undefined
}

// ── JSON-LD 结构化数据 ─────────────────────────────────────

/** 首页：WebSite */
export function websiteJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME_FULL,
    alternateName: SITE_NAME,
    url: absoluteUrl('/'),
    description: SITE_DESCRIPTION,
    inLanguage: LOCALE,
  }
}

/** 首页：Organization（品牌实体，帮助搜索引擎把品牌名与站点关联） */
export function organizationJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME_FULL,
    alternateName: SITE_NAME,
    url: absoluteUrl('/'),
    logo: absoluteUrl('/logo.png'),
    description: SITE_DESCRIPTION,
  }
}

/** 面包屑（层级页面通用；items 顺序即面包屑顺序） */
export function breadcrumbJsonLd(items: Array<{ name: string; path: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  }
}

/** 文章/作品详情页（未来若开放公开阅读可直接使用） */
export function articleJsonLd(input: {
  title: string
  description: string
  path: string
  image?: string
  publishedTime?: string
  modifiedTime?: string
  authorName?: string
}): Record<string, unknown> {
  const imageUrl = absoluteUrl(input.image ?? DEFAULT_OG_IMAGE)
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: clamp(input.title, 110),
    description: clamp(input.description, 300),
    image: [imageUrl],
    datePublished: input.publishedTime,
    dateModified: input.modifiedTime ?? input.publishedTime,
    mainEntityOfPage: { '@type': 'WebPage', '@id': absoluteUrl(input.path) },
    author: { '@type': 'Person', name: input.authorName ?? SITE_NAME_FULL },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME_FULL,
      logo: { '@type': 'ImageObject', url: absoluteUrl('/logo.png') },
    },
    inLanguage: LOCALE,
  }
}
