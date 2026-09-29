import type { NextConfig } from "next";

// ── 安全响应头 ──────────────────────────────────────────
// 这里只加「不会破坏功能」的那一类头，收益/风险比最高：
//   - X-Content-Type-Options: 关闭 MIME 嗅探，防止 .txt 被当 HTML 执行
//   - X-Frame-Options:        禁止被第三方站点iframe 嵌套（点击劫持）
//   - Referrer-Policy:       跨站只带 origin，不外泄站内路径（如 /works/xxx）
//   - Permissions-Policy:    明确关闭摄像头/麦克风/定位，避免误授权
//
// 为什么**不加 CSP**：App Router 会注入内联引导脚本（self.__next_f.push），
// 在没有 nonce 机制的前提下强行上 CSP 必须开 'unsafe-inline'，XSS 防护收益被抵消；
// 且容易漏配 Supabase 域名/图片外链，直接导致线上白屏。
// 真正要上 CSP 时应走 middleware + 每请求 nonce，那是独立改造，不在这里做。
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  // HSTS 只在生产环境下发：本地 http 开发若被浏览器记住强制跳 https，会很难清
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
];

// ── 静态资源缓存 ────────────────────────────────────────
// public/ 下的文件没有内容哈希，不能设 immutable；
// 一周强缓存 + 后台续期（stale-while-revalidate）是体积与新鲜度的平衡点。
// /_next/static/* 的指纹文件 Next 已自动下发一年 immutable，无需重复配置。
const staticCacheHeaders = [
  {
    key: "Cache-Control",
    value: "public, max-age=604800, stale-while-revalidate=86400",
  },
];

const nextConfig: NextConfig = {
  /* config options here */

  // Next 16 起，App Router 每次客户端导航都会走 useTransition，
  // pending 期间 dev 指示器会弹出 "Rendering..." 遮罩。
  // 它只注入在 app-page*.runtime.dev.js 中，生产构建完全不存在，属纯开发期噪音。
  // 副作用：右下角 Next 开发指示器图标会一并隐藏，需要时把这两行注释掉即可。
  devIndicators: false,

  poweredByHeader: false,

  // 图片优化：按浏览器能力优先输出 AVIF，其次 WebP（体积比原图小 30%+）。
  // 同时放行 Supabase Storage 的公开图片，未来社区图片接入 next/image 时无需再改。
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },

  // 301 永久重定向：旧地址直接在服务端跳到最终地址，
  // 搜索引擎会把权重合并到新 URL，旧收藏也不会失效。
  async redirects() {
    return [
      // 作品详情已统一迁移到「持续创作空间」/article/[id]
      { source: "/works/:id", destination: "/article/:id", statusCode: 301 },
    ];
  },

  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // public/ 静态资源：图片 / 图标 / 字体 / 音视频
      {
        source: "/:path*.:ext(png|jpeg|jpg|gif|webp|avif|svg|ico|mp4|woff2)",
        headers: staticCacheHeaders,
      },
      {
        source: "/images/:path*",
        headers: staticCacheHeaders,
      },
      // 用户私有数据（积分余额/流水/个人资料）禁止任何中间层缓存：
      // 这类响应一旦被 CDN 或浏览器缓存，会出现「看到别人的余额」。
      // 范围刻意收窄到 /api/user 与 /api/admin，不影响社区等可缓存接口的性能。
      {
        source: "/api/user/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        source: "/api/admin/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
