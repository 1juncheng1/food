import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./vision.css";
import { AuthProvider } from "@/components/auth-provider";
import { VisionAmbient } from "@/components/vision/ambient";
import {
  DEFAULT_OG_IMAGE,
  SITE_DESCRIPTION,
  SITE_NAME_FULL,
  SITE_URL,
  absoluteUrl,
  siteVerification,
} from "@/lib/seo";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// ── 全站默认元信息 ──────────────────────────────────────────
// 这里只放「所有页面共享」的默认值；每个页面的独立标题/描述/canonical
// 由 lib/seo.ts 的 pageMetadata() 生成（见各路由的 layout.tsx）。
//
// 注意：刻意不在这里设置 alternates.canonical —— canonical 会被子路由
// 继承，全局设成 '/' 会让所有内页都指向首页（典型的重复内容事故）。
export const metadata: Metadata = {
  // 让 Next 能把相对地址解析成绝对地址（OG 图片 / canonical 都依赖它）
  metadataBase: new URL(SITE_URL),

  title: `${SITE_NAME_FULL} · 让 AI 越来越懂你的创作伙伴`,
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME_FULL,

  // 搜索引擎站点所有权验证（Google / Bing=Edge / 百度）
  // 验证码从环境变量读，没配置就不输出任何 meta —— 见 lib/seo.ts
  verification: siteVerification(),

  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },

  openGraph: {
    type: "website",
    url: absoluteUrl("/"),
    siteName: SITE_NAME_FULL,
    locale: "zh-CN",
    images: [
      {
        url: absoluteUrl(DEFAULT_OG_IMAGE),
        width: 1200,
        height: 630,
        alt: `${SITE_NAME_FULL} · 让 AI 越来越懂你的创作伙伴`,
      },
    ],
  },

  twitter: {
    card: "summary_large_image",
    images: [absoluteUrl(DEFAULT_OG_IMAGE)],
  },

  icons: {
    icon: [{ url: "/logo.png", sizes: "any", type: "image/png" }],
    apple: [{ url: "/logo.png", sizes: "any", type: "image/png" }],
  },
};

// viewport 单独导出（Next 15+ 起放在 metadata 里会被忽略）
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#07080b",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* body 加深色背景：直接输入 URL 进入时不再出现白屏闪烁 */}
      <body className="min-h-full flex flex-col bg-[var(--vs-void)]">
        <VisionAmbient />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
