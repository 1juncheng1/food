import { WORKFLOW_STEPS } from '@/lib/home-content'
import { Reveal } from '@/components/vision'

// ────────────────────────────────────────────────────────────
// 创作流程
//
// 做成一条时间轴：横贯的细线 + 刻度 + 等宽序号，
// 像剪辑台上的时间标尺，而不是六个带数字的圆点。
// 没有流光、没有呼吸、没有连接线动画。
// ────────────────────────────────────────────────────────────

export function WorkflowSection() {
  return (
    <section className="vs-section" id="workflow">
      <div className="vs-container">
        <Reveal className="vs-section-head">
          <p className="vs-mark">创作流程</p>
          <h2 className="vs-h2 mt-4">从想法到作品，每一步都有 AI 参与</h2>
          <p className="vs-body mt-4">
            不是输入一句话然后等待结果，而是与 AI 一起把想法推向可以发布的状态。
          </p>
        </Reveal>

        <Reveal className="relative border-t border-[var(--vs-line)] pt-8">
          {/* 时间轴：横贯全宽的一条细线 */}
          <div
            className="absolute inset-x-0 top-0 h-px bg-[var(--vs-line)]"
            aria-hidden="true"
          />

          <ol className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-6 lg:gap-x-6">
            {WORKFLOW_STEPS.map((step, i) => (
              <li key={step.id} className="relative pt-4">
                {/* 刻度：从时间轴垂下的 8px 短线 */}
                <span
                  className="absolute left-0 top-0 h-2 w-px bg-[var(--vs-beam-line)]"
                  aria-hidden="true"
                />
                <span className="vs-num vs-num-dim block text-[12px]">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="mt-2 text-[15px] font-medium text-[var(--vs-ink)]">
                  {step.title}
                </h3>
                <p className="mt-1.5 text-[12.5px] leading-[1.6] text-[var(--vs-ink-4)]">
                  {step.note}
                </p>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </section>
  )
}
