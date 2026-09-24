import { HomeNav } from '@/components/home/home-nav'
import { HeroSection } from '@/components/home/hero-section'
import { GrowthPathSection } from '@/components/home/growth-path-section'
import { CapabilitySection } from '@/components/home/capability-section'
import { WorkflowSection } from '@/components/home/workflow-section'
import { CommunityPreviewSection } from '@/components/home/community-preview-section'
import { FooterCTA } from '@/components/home/footer-cta'

// ────────────────────────────────────────────────────────────
// 首页 Landing Page：负责组装，具体区块拆到 components/home/*
//
// 认知路径：
//   Hero（这是 AI 创作伙伴）
//   → 成长路径（为什么区别于普通 AI：会持续理解我）
//   → 核心能力（它到底能做什么）
//   → 创作流程（它是怎么陪我创作的）
//   → 灵感社区（不止我一个人）
//   → 开始创作入口
// ────────────────────────────────────────────────────────────

export default function HomePage() {
  return (
    <div className="home-page lp-shell">
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
