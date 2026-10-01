import Link from 'next/link'
import { COMMUNITY_SAMPLES } from '@/lib/home-content'
import { ImageSlot, Reveal, IconArrowRight } from '@/components/vision'
import { HOME_IMAGES } from '@/lib/vision-assets'

// ────────────────────────────────────────────────────────────
// 灵感社区预览
//
// 一个特写 + 两条索引，像一个有内容氛围的社区，
// 而不是三张同样大小的卡片。
// 数据来源：内置示例（首页对未登录用户开放，不请求接口，保证首屏零请求）
//
// 特写按素材原始比例（1080×607）渲染：原先写死 16/10，比素材更窄，
// cover 会左右各切掉一截。比例跟着素材走，才是「整张图」。
// ────────────────────────────────────────────────────────────

export function CommunityPreviewSection() {
  const [featured, ...rest] = COMMUNITY_SAMPLES

  return (
    <section className="vs-section" id="community">
      <div className="vs-container">
        <Reveal className="vs-section-head">
          <p className="vs-mark">灵感社区</p>
          <h2 className="vs-h2 mt-4">连接创作者的想法</h2>
          <p className="vs-body mt-4">
            银河叙事不只陪伴你一个人创作。分享作品、交流观点，也能看见别人如何思考。
          </p>
        </Reveal>

        <div className="grid gap-x-14 gap-y-12 lg:grid-cols-[minmax(0,1.16fr)_minmax(0,0.84fr)]">
          <Reveal>
            <div className="vs-frame">
              <ImageSlot
                src={HOME_IMAGES.community.src}
                kind="editorial-image"
                ratio={`${HOME_IMAGES.community.width} / ${HOME_IMAGES.community.height}`}
                alt="一个孩子伸出手，去触碰自己在墙上投下的那只巨大的手掌影子"
              />
            </div>
            <p className="vs-mark mt-5">{featured.tag}</p>
            <h3 className="vs-h3 mt-2">{featured.title}</h3>
            <p className="mt-2.5 text-[14px] leading-[1.75] text-[var(--vs-ink-3)]">
              {featured.excerpt}
            </p>
            <p className="vs-num vs-num-dim mt-4 text-[12px]">{featured.author}</p>
          </Reveal>

          <div>
            {rest.map((post, i) => (
              <Reveal
                key={post.id}
                delay={i * 90}
                className="border-t border-[var(--vs-line)] py-6 first:border-t-0 first:pt-0"
              >
                <p className="vs-mark">{post.tag}</p>
                <h3 className="mt-2 text-[16px] font-medium leading-[1.5] text-[var(--vs-ink)]">
                  {post.title}
                </h3>
                <p className="mt-2 text-[13.5px] leading-[1.7] text-[var(--vs-ink-3)]">
                  {post.excerpt}
                </p>
                <p className="vs-num vs-num-dim mt-3 text-[12px]">{post.author}</p>
              </Reveal>
            ))}

            <Reveal delay={180} className="mt-8 border-t border-[var(--vs-line)] pt-6">
              <Link href="/explore" className="vs-link">
                进入灵感广场
                <IconArrowRight size={15} className="vs-link-arrow" />
              </Link>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  )
}
