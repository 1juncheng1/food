import { GROWTH_PATH } from '@/lib/home-content'
import { Reveal } from './reveal'
import { VisualPlaceholder } from './visual-placeholder'

// ────────────────────────────────────────────────────────────
// 创作者成长路径：在创作中成长，在成长中创作
// 三列卡片：图片占位区 + 标题 + 描述（标注对应系统）
// ────────────────────────────────────────────────────────────

export function GrowthPathSection() {
  return (
    <section className="lp-section" id="growth">
      <div className="lp-container">
        <Reveal className="lp-section-head">
          <span className="lp-eyebrow">创作者成长路径</span>
          <h2 className="lp-section-title lp-gradient-text">在创作中成长，在成长中创作</h2>
          <p className="lp-section-sub">
            每一次创作都会沉淀为对你的理解。你用得越久，视界越接近你。
          </p>
        </Reveal>

        <div className="lp-path-grid">
          {GROWTH_PATH.map((item, i) => (
            <Reveal key={item.id} delay={i * 90} className="lp-path-card-wrap">
              <article className="lp-path-card">
                <div className="lp-path-media">
                  <VisualPlaceholder src={item.image} alt={item.title} label={item.placeholder} />
                  <span className="lp-path-index">{String(i + 1).padStart(2, '0')}</span>
                </div>
                <div className="lp-path-body">
                  <span className="lp-path-system">{item.system}</span>
                  <h3 className="lp-path-title">{item.title}</h3>
                  <p className="lp-path-desc">{item.desc}</p>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
