// ────────────────────────────────────────────────────────────
// 视界图标集（全站统一）
//
// 规则：
//   - 24 视框、线性、统一 strokeWidth 1.5（细线是精密感的来源）
//   - 不引入额外图标依赖，不混用第二套图标族
//   - 只画"功能需要"的图标，不做装饰图形
// ────────────────────────────────────────────────────────────

interface IconProps {
  className?: string
  size?: number
}

function Line({
  size = 20,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** 图片槽提示：取景框 */
export function IconSlot(props: IconProps) {
  return (
    <Line {...props}>
      <path d="M3 8.5V6a2 2 0 0 1 2-2h2.5" />
      <path d="M16.5 4H19a2 2 0 0 1 2 2v2.5" />
      <path d="M21 15.5V18a2 2 0 0 1-2 2h-2.5" />
      <path d="M7.5 20H5a2 2 0 0 1-2-2v-2.5" />
      <circle cx="12" cy="12" r="2.6" />
    </Line>
  )
}

/** 向右箭头 */
export function IconArrowRight(props: IconProps) {
  return (
    <Line {...props}>
      <path d="M4.5 12h15" />
      <path d="M13.5 6l6 6-6 6" />
    </Line>
  )
}

/** 播放（为未来视频扩展预留） */
export function IconPlay(props: IconProps) {
  return (
    <Line {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10.2 8.6l5.4 3.4-5.4 3.4z" />
    </Line>
  )
}

/** 灵感推荐：罗盘 */
export function IconCompass(props: IconProps) {
  return (
    <Line {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.6 8.4l-2.1 5.1-5.1 2.1 2.1-5.1z" />
    </Line>
  )
}

/** 创作者画像：人像 */
export function IconProfile(props: IconProps) {
  return (
    <Line {...props}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
    </Line>
  )
}

/** 个人知识库：档案 */
export function IconLibrary(props: IconProps) {
  return (
    <Line {...props}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
      <path d="M10 4h8.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H10" />
      <path d="M13.5 8.5h4M13.5 12h4" />
    </Line>
  )
}

/** AI 共创：协作 */
export function IconCoCreate(props: IconProps) {
  return (
    <Line {...props}>
      <path d="M20 12.5a7 7 0 0 1-7 7H8l-4 3v-9.6a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7z" />
      <path d="M9 11.5h6M9 14.5h3.5" />
    </Line>
  )
}

/** 灵感社区：人群 */
export function IconCommunity(props: IconProps) {
  return (
    <Line {...props}>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6" />
      <path d="M17.8 14.6a5 5 0 0 1 2.7 4.4" />
    </Line>
  )
}

export const CAPABILITY_ICONS = {
  compass: IconCompass,
  profile: IconProfile,
  library: IconLibrary,
  cocreate: IconCoCreate,
  community: IconCommunity,
} as const
