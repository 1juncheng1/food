import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/components/auth-provider";
import { AuroraBackground } from "@/components/aurora";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "视界",
  description: "粘贴你喜欢的解说文案，AI 学习你的语气和节奏，生成同风格的新解说稿。",
  icons: {
    icon: [{ url: "/logo.png", sizes: "any", type: "image/png" }],
    apple: [{ url: "/logo.png", sizes: "any", type: "image/png" }],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* body 加深色背景：直接输入 URL 进入时不再出现白屏闪烁 */}
      <body className="min-h-full flex flex-col bg-zinc-950">
        <AuroraBackground />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
