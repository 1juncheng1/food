import type { Metadata } from 'next'
import { HomeNav } from '@/components/home/home-nav'
import { HeroSection } from '@/components/home/hero-section'
import { GrowthPathSection } from '@/components/home/growth-path-section'
import { CapabilitySection } from '@/components/home/capability-section'
import { WorkflowSection } from '@/components/home/workflow-section'
import { CommunityPreviewSection } from '@/components/home/community-preview-section'
import { FooterCTA } from '@/components/home/footer-cta'
import { JsonLd } from '@/components/seo/json-ld'
import { organizationJsonLd, pageMetadata, websiteJsonLd } from '@/lib/seo'

// ────────────────────────────────────────────────────────────
// 首页：负责组装，具体区块拆到 components/home/*
//
// 认知路径（一条电影叙事线，不是功能列表）：
//   开场：这是 AI 创作伙伴（首屏 + 建立镜头）
//   → 成长路径：为什么区别于普通 AI，它会持续理解我
//   → 核心能力：它到底能做什么
//   → 创作流程：它是怎么陪我创作的
//   → 灵感社区：不止我一个人在这里创作
//   → 收尾：进入创作
//
// 视觉语言统一来自 app/vision.css，本页只负责结构与顺序。
// ────────────────────────────────────────────────────────────

export const metadata: Metadata = pageMetadata({
  title: '视界 Vision · 让 AI 越来越懂你的创作伙伴',
  description:
    '视界是一个越来越懂你的 AI 创作伙伴。它理解你的灵感、知识与表达方式，陪伴你把模糊想法变成有依据、有观点、可以真正发布的作品。',
  path: '/',
})

export default function HomePage() {
  return (
    <div className="vs-shell">
      {/* 结构化数据：WebSite + Organization，帮助搜索引擎理解品牌实体 */}
      <JsonLd data={websiteJsonLd()} />
      <JsonLd data={organizationJsonLd()} />

      <HomeNav />
      <main>
        <HeroSection />
        <GrowthPathSection />
        <CapabilitySection />
        <WorkflowSection />
        <CommunityPreviewSection />
      </main>
      <FooterCTA />
    </div>
  )
}
