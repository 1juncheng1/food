import Link from 'next/link'
import { COMMUNITY_SAMPLES } from '@/lib/home-content'
import { Reveal } from './reveal'
import { IconArrowRight } from './home-icons'

// ────────────────────────────────────────────────────────────
// 灵感社区预览
// 重点：让"视界不仅帮助个人创作，也连接创作者"被看见。
// 数据来源：内置示例（/api/posts 需要登录，首页对未登录用户开放，
// 因此不请求接口，保证首屏零请求、无 401）
// ────────────────────────────────────────────────────────────

export function CommunityPreviewSection() {
  return (
    <section className="lp-section lp-section-alt" id="community">
      <div className="lp-container">
        <Reveal className="lp-section-head">
          <span className="lp-eyebrow">灵感社区</span>
          <h2 className="lp-section-title lp-gradient-text">连接创作者的想法</h2>
          <p className="lp-section-sub">
            视界不只陪伴你一个人创作。分享作品、交流观点，也能看见别人如何思考。
          </p>
        </Reveal>

        <div className="lp-community-grid">
          {COMMUNITY_SAMPLES.map((post, i) => (
            <Reveal key={post.id} delay={i * 90} className="lp-post-cell">
              <article className="lp-post-card">
                <div className="lp-post-head">
                  <span className="lp-post-tag">{post.tag}</span>
                </div>
                <h3 className="lp-post-title">{post.title}</h3>
                <p className="lp-post-excerpt">{post.excerpt}</p>
                <div className="lp-post-author">
                  <span className="lp-avatar" aria-hidden="true">
                    {post.author.slice(0, 1)}
                  </span>
                  <span className="lp-post-meta">{post.author}</span>
                </div>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal className="lp-community-cta" delay={120}>
          <Link href="/explore" className="lp-btn lp-btn-ghost">
            进入灵感广场
            <IconArrowRight size={16} />
          </Link>
        </Reveal>
      </div>
    </section>
  )
}
