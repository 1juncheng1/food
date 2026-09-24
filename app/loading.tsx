// 路由切换时立即显示的加载状态，避免用户看到旧页面"卡住"
// 文案遵循全站规则：说明系统在为你准备什么，而不是"加载中"
export default function Loading() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="flex items-center gap-2.5 text-[13px] text-indigo-200/90">
        <span className="inline-flex items-center gap-[3px]">
          <i className="vs-ai-dot" />
          <i className="vs-ai-dot" />
          <i className="vs-ai-dot" />
        </span>
        <span>正在准备你的创作空间…</span>
      </div>
    </div>
  )
}
