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

const nextConfig: NextConfig = {
  /* config options here */

  // Next 16 起，App Router 每次客户端导航都会走 useTransition，
  // pending 期间 dev 指示器会弹出 "Rendering..." 遮罩。
  // 它只注入在 app-page*.runtime.dev.js 中，生产构建完全不存在，属纯开发期噪音。
  // 副作用：右下角 Next 开发指示器图标会一并隐藏，需要时把这两行注释掉即可。
  devIndicators: false,

  poweredByHeader: false,

  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
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
