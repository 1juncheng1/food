/**
 * VS Design System 统一出口
 * 所有功能页只允许从这里取通用 UI，禁止各页自己手写卡片/空态/加载态。
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
