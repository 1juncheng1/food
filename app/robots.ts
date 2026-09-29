import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/seo'

// ────────────────────────────────────────────────────────────
// robots.txt（构建后通过 https://站点域名/robots.txt 访问）
//
// 原则：
//   - 公开页放行；所有需要登录的内部页、后台、API 一律 Disallow
//   - 带 query string 的 URL 全部禁止（防 ?rec_id=、?utm_*= 等产生
//     无限变体 URL 稀释抓取预算），/_next/image 显式放回，
//     因为 Googlebot 需要抓取它来获取压缩后的图片
//
// 注意：robots.txt 只是「抓取」控制；「收录」控制靠页面里的
// noindex（见 lib/seo.ts 的 appPageMetadata）。两者必须配套修改。
// ────────────────────────────────────────────────────────────

/** 非公开路径：登录后才能访问的功能页 + 后台 + API */
const PRIVATE_PREFIXES = [
  '/api/',
  '/admin/',
  '/dashboard',
  '/generate',
  '/explore',
  '/inspiration-feed',
  '/knowledge',
  '/materials',
  '/points',
  '/publish',
  '/recharge',
  '/settings',
  '/style-profile',
  '/add',
  '/works',
  '/article/',
  '/post/',
  '/solution/',
  '/solutions',
  '/profile',
  '/login',
  '/register',
  '/welcome',
]

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/_next/image'],
        // /*?* 匹配一切带查询参数的 URL（Google/Bing/百度均支持通配符）
        disallow: [...PRIVATE_PREFIXES, '/*?*'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
