import { WORKFLOW_STEPS } from '@/lib/home-content'
import { Reveal } from './reveal'

// ────────────────────────────────────────────────────────────
// AI 创作流程：从想法到作品，每一步都有AI陪伴
// Desktop 横向 6 步 + 流光连接线；Mobile 转为纵向时间轴
// ────────────────────────────────────────────────────────────

export function WorkflowSection() {
  return (
    <section className="lp-section" id="workflow">
      <div className="lp-container">
        <Reveal className="lp-section-head">
          <span className="lp-eyebrow">创作流程</span>
          <h2 className="lp-section-title lp-gradient-text">从想法到作品，每一步都有AI陪伴</h2>
          <p className="lp-section-sub">
            不是输入一句话然后等待结果，而是与 AI 一起把想法推向可以发布的状态。
          </p>
        </Reveal>

        <Reveal className="lp-flow-panel">
          <ol className="lp-flow">
            {WORKFLOW_STEPS.map((step, i) => (
              <li key={step.id} className="lp-flow-step">
                <span className="lp-flow-dot">{i + 1}</span>
                <span className="lp-flow-text">
                  <span className="lp-flow-title">{step.title}</span>
                  <span className="lp-flow-note">{step.note}</span>
                </span>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </section>
  )
}
