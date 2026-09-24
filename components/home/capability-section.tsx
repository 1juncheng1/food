import { CAPABILITIES } from '@/lib/home-content'
import { Reveal } from './reveal'
import { CAPABILITY_ICONS } from './home-icons'

// ────────────────────────────────────────────────────────────
// 核心能力：只讲能力，不展示"电影解说 / 短剧文案"这类模板类型，
// 避免用户把视界理解成一次性生成工具。
// 布局：6 栅格 → 首行 3 张（各占 2 列），次行 2 张（各占 3 列）
// ────────────────────────────────────────────────────────────

export function CapabilitySection() {
  return (
    <section className="lp-section lp-section-alt" id="capabilities">
      <div className="lp-container">
        <Reveal className="lp-section-head">
          <span className="lp-eyebrow">核心能力</span>
          <h2 className="lp-section-title lp-gradient-text">不是一个写作工具，而是一套创作系统</h2>
          <p className="lp-section-sub">
            从发现方向到沉淀资产，视界参与创作的每一个环节，并把过程变成对你的理解。
          </p>
        </Reveal>

        <div className="lp-cap-grid">
          {CAPABILITIES.map((item, i) => {
            const Icon = CAPABILITY_ICONS[item.icon]
            // 前 3 张各占 2 列，后 2 张各占 3 列 → 3 + 2 的稳定两行
            const wide = i >= 3
            return (
              <Reveal key={item.id} delay={(i % 3) * 90} className={wide ? 'lp-cap-cell wide' : 'lp-cap-cell'}>
                <article className="lp-cap-card spotlight-card">
                  <span className="lp-cap-icon">
                    <Icon size={20} />
                  </span>
                  <h3 className="lp-cap-title">{item.title}</h3>
                  <p className="lp-cap-desc">{item.desc}</p>
                </article>
              </Reveal>
            )
          })}
        </div>
      </div>
    </section>
  )
}
