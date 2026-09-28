import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./vision.css";
import { AuthProvider } from "@/components/auth-provider";
import { VisionAmbient } from "@/components/vision/ambient";
import { Analytics } from "@vercel/analytics/next";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "视界 Vision · 让AI越来越懂你的创作伙伴",
  description:
    "视界是一个越来越懂你的 AI 创作伙伴。它理解你的灵感、知识与表达方式，陪伴你把模糊想法变成有依据、有观点、可以真正发布的作品。",
  icons: {
    icon: [{ url: "/logo.png", sizes: "any", type: "image/png" }],
    apple: [{ url: "/logo.png", sizes: "any", type: "image/png" }],
  },
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
        <Analytics />
      </body>
    </html>
  );
}
