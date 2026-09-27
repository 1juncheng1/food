/**
 * 视界视觉系统统一出口
 * 所有页面只允许从这里取通用 UI，禁止各页自己手写卡片 / 空态 / 加载态 / 图片位。
 */
export { PageShell, PageGap } from './page-shell'
export { PageHeader } from './page-header'
export { AiStatus, AiPulse } from './ai-status'
export { Section } from './section'
export { SurfaceCard, CardLabel } from './surface-card'
export { EmptyState } from './empty-state'
export { ErrorState } from './error-state'
export { Skeleton, SkeletonList, SkeletonText } from './skeleton'
export { TagChip } from './tag-chip'
export type { ChipTone } from './tag-chip'
export { StatRow } from './stat-row'
export { ImageSlot } from './image-slot'
export { Reveal } from './reveal'
export {
  IconSlot,
  IconArrowRight,
  IconPlay,
  IconCompass,
  IconProfile,
  IconLibrary,
  IconCoCreate,
  IconCommunity,
  CAPABILITY_ICONS,
} from './icons'
