// ────────────────────────────────────────────────────────────
// 全站极光星野氛围层（纯装饰）
// - .aurora-blobs：z-index -1，位于页面背景之下、body 背景之上
// - .aurora-grain：胶片噪点，z-index 1 覆盖内容，极低透明度
// 全部为静态 DOM + CSS 动画，无交互、无客户端 JS
// ────────────────────────────────────────────────────────────

export function AuroraBackground() {
  return (
    <>
      <div className="aurora-blobs" aria-hidden="true">
        <div className="aurora-blob b1" />
        <div className="aurora-blob b2" />
        <div className="aurora-blob b3" />
        <div className="aurora-stars" />
      </div>
      <div className="aurora-grain" aria-hidden="true" />
    </>
  )
}
