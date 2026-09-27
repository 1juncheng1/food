import { GROWTH_PATH } from '@/lib/home-content'
import { ImageSlot, Reveal } from '@/components/vision'

// ────────────────────────────────────────────────────────────
// 创作者成长路径
//
// 不做三张一样的卡片：三格宽度不等、纵向错开，
// 用细线与序号组织，读起来像一组分镜，而不是一组功能模块。
//
// 封面必须是「完整的一张图」：三张素材原始比例不同（见 GROWTH_PATH 的
// width / height），所以每张按自己的比例预留空间。只要 aspect-ratio 与
// 素材像素尺寸一致，object-fit: cover 就不会裁掉任何像素——
// 这也是为什么不能在这里统一写死一个比例。
// ────────────────────────────────────────────────────────────

export function GrowthPathSection() {
  return (
    <section className="vs-section" id="growth">
      <div className="vs-container">
        <Reveal className="vs-section-head">
          <p className="vs-mark">创作者成长路径</p>
          <h2 className="vs-h2 mt-4">在创作中成长，在成长中创作</h2>
          <p className="vs-body mt-4">
            每一次创作都会沉淀为对你的理解。你用得越久，视界越接近你。
          </p>
        </Reveal>

        <div className="grid gap-x-10 gap-y-14 md:grid-cols-[1.18fr_0.94fr_0.94fr] md:gap-x-8">
          {GROWTH_PATH.map((item, i) => (
            <Reveal
              key={item.id}
              delay={i * 90}
              className={i === 1 ? 'md:mt-12' : i === 2 ? 'md:mt-5' : undefined}
            >
              <div className="vs-frame">
                <ImageSlot
                  src={item.image}
                  kind="feature-image"
                  ratio={`${item.width} / ${item.height}`}
                  alt={item.title}
                />
              </div>

              <div className="mt-5 flex items-baseline gap-3">
                <span className="vs-num vs-num-dim text-[13px]">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="vs-h3">{item.title}</h3>
              </div>

              <p className="mt-2.5 text-[14px] leading-[1.75] text-[var(--vs-ink-3)]">
                {item.desc}
              </p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
