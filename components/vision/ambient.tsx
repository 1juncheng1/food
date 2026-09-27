// ────────────────────────────────────────────────────────────
// 全站氛围层（纯装饰，无交互、无客户端 JS）
//
// 只有两层：
//   1. 一层极慢移动的冷蓝微光，负责"空间有深度"
//   2. 一层胶片噪点，负责"这不是一块纯色屏幕"
//
// 明确不做：粒子、流星、星野、闪烁、紫蓝极光。
// 那些是装饰噪音，会拉低产品的可信度。
// ────────────────────────────────────────────────────────────

export function VisionAmbient() {
  return (
    <>
      <div className="vs-ambient" aria-hidden="true">
        <div className="vs-ambient-wash" />
      </div>
      <div className="vs-grain" aria-hidden="true" />
    </>
  )
}
