import { CAPABILITIES } from '@/lib/home-content'
import { ImageSlot, Reveal, CAPABILITY_ICONS } from '@/components/vision'
import { HOME_IMAGES } from '@/lib/vision-assets'

// ────────────────────────────────────────────────────────────
// 核心能力
//
// 左侧是一张插画位（这里必须出现真实视觉，否则整段只剩文字）；
// 右侧是能力索引，用细线分隔的条目而不是五张卡片。
// 只讲能力，不讲模板类型：避免把视界理解成一次性生成工具。
//
// 插画按素材原始比例（735×985）渲染：这个槽位原先写死 4/5，比素材更宽，
// 用 cover 会左右各切掉一截。比例跟着素材走，才谈得上「整张图」。
// ────────────────────────────────────────────────────────────

export function CapabilitySection() {
  return (
    <section className="vs-section" id="capabilities">
      <div className="vs-container">
        <Reveal className="vs-section-head">
          <p className="vs-mark">核心能力</p>
          <h2 className="vs-h2 mt-4">不是一个写作工具，而是一套创作系统</h2>
          <p className="vs-body mt-4">
            从发现方向到沉淀资产，视界参与创作的每一个环节，并把过程变成对你的理解。
          </p>
        </Reveal>

        <div className="grid gap-x-14 gap-y-12 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1fr)]">
          <Reveal>
            <div className="vs-frame vs-frame-marked">
              <ImageSlot
                src={HOME_IMAGES.capability.src}
                kind="illustration"
                ratio={`${HOME_IMAGES.capability.width} / ${HOME_IMAGES.capability.height}`}
                alt="一个人站在不断转折、通往高处的阶梯上"
              />
            </div>
          </Reveal>

          <div>
            {CAPABILITIES.map((item, i) => {
              const Icon = CAPABILITY_ICONS[item.icon]
              return (
                <Reveal
                  key={item.id}
                  delay={i * 70}
                  className="border-t border-[var(--vs-line)] py-5 first:border-t-0 first:pt-0"
                >
                  <div className="flex gap-4">
                    <span className="vs-num vs-num-dim mt-0.5 text-[12px]">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="mt-0.5 shrink-0 text-[var(--vs-beam-text)] opacity-70">
                      <Icon size={18} />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-[16px] font-medium text-[var(--vs-ink)]">
                        {item.title}
                      </h3>
                      <p className="mt-1.5 text-[13.5px] leading-[1.7] text-[var(--vs-ink-3)]">
                        {item.desc}
                      </p>
                    </div>
                  </div>
                </Reveal>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
