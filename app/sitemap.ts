import type { MetadataRoute } from 'next'
import { PUBLIC_PATHS, absoluteUrl } from '@/lib/seo'

// ────────────────────────────────────────────────────────────
// sitemap.xml（构建后通过 https://站点域名/sitemap.xml 访问）
//
// 只收录「无需登录即可完整阅读」的页面，清单来自 lib/seo.ts 的 PUBLIC_PATHS，
// 与 IndexNow 推送（lib/indexnow.ts）共用同一份，不会出现两处不一致。
//
// 当前站点状态：首页 / 是唯一对搜索引擎开放的页面；/explore、/post/[id]
// 等社区页都需要登录（AuthGuard 会把爬虫弹到 /login），所以不进 sitemap，
// 否则搜索引擎会收录一堆登录墙空壳，拉低整站质量评分。
//
// 以后新增公开页时（三处必须一起改，缺一不可）：
//   1. 在 lib/seo.ts 的 PUBLIC_PATHS 加一条  → sitemap 与 IndexNow 自动生效
//   2. 在 app/robots.ts 的 PRIVATE_PREFIXES 移除对应前缀
//   3. 把该页 metadata 的 index 改为 true（见 lib/seo.ts 的 pageMetadata）
// ────────────────────────────────────────────────────────────

/**
 * 动态公开路由。
 *
 * 当社区内容页开放为「无需登录可读」后，在这里查库即可自动生成，
 * 例如（使用服务端 Supabase client，注意必须在服务端执行）：
 *
 *   const { data } = await supabase
 *     .from('posts')
 *     .select('id, updated_at')
 *     .eq('is_public', true)
 *     .order('updated_at', { ascending: false })
 *     .limit(5000)
 *   return (data ?? []).map((p) => ({
 *     url: absoluteUrl(`/post/${p.id}`),
 *     lastModified: p.updated_at ? new Date(p.updated_at) : undefined,
 *     changeFrequency: 'weekly',
 *     priority: 0.6,
 *   }))
 *
 * 现阶段社区页需登录，返回空数组。
 */
async function getDynamicPublicRoutes(): Promise<MetadataRoute.Sitemap> {
  return []
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()

  const staticRoutes: MetadataRoute.Sitemap = PUBLIC_PATHS.map((path) => ({
    url: absoluteUrl(path),
    lastModified: now,
    changeFrequency: 'weekly',
    // 首页权重最高，其余公开页次之
    priority: path === '/' ? 1 : 0.7,
  }))

  let dynamicRoutes: MetadataRoute.Sitemap = []
  try {
    dynamicRoutes = await getDynamicPublicRoutes()
  } catch {
    // 数据库不可用时不阻断构建/请求，宁可少列也不要输出坏 sitemap
    dynamicRoutes = []
  }

  return [...staticRoutes, ...dynamicRoutes]
}
