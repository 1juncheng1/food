import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */

  // Next 16 起，App Router 每次客户端导航都会走 useTransition，
  // pending 期间 dev 指示器会弹出 "Rendering..." 遮罩。
  // 它只注入在 app-page*.runtime.dev.js 中，生产构建完全不存在，属纯开发期噪音。
  // 副作用：右下角 Next 开发指示器图标会一并隐藏，需要时把这两行注释掉即可。
  devIndicators: false,
};

export default nextConfig;
