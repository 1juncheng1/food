// ============================================================
// 列表页滚动位置记忆（素材库 dashboard → 作品详情 → 返回 时恢复精确 scrollTop）
//
// 设计约束（唯一滚动控制入口，避免多处互相覆盖）：
// 1. 写入：点击作品跳转前调用 saveDashboardState()；pagehide 时兜底再存一次。
// 2. 读取：仅在「popstate（浏览器/按钮的前进、后退）后重新挂载」时恢复；
//    侧边栏主动 push 进入 /dashboard、直接访问 URL 一律不恢复（保持顶部）。
// 3. 恢复时机：列表真实 DOM 渲染完成后启动 rAF 校验循环——
//    骨架屏阶段页面高度不足，直接 scrollTo 会被浏览器钳制到 0，
//    因此每帧用最新 scrollHeight 重算可滚动上限，直到高度足够或超时。
// 4. 不使用固定 setTimeout 作为唯一恢复手段。
// ============================================================

const STORAGE_KEY = 'shijie_dashboard_scroll_v1'
const STALE_MS = 30 * 60 * 1000 // 记忆有效期 30 分钟，过期视为陈旧不恢复
const POP_FRESH_MS = 10 * 1000 // popstate 后多久内的挂载算"返回挂载"
const RESTORE_MAX_FRAMES = 120 // 约 2 秒（60fps），覆盖骨架屏→真实列表的渲染窗口

export interface DashboardScrollState {
  y: number
  filter: string
  savedAt: number
}

// popstate 模块级标记：dashboard 首次加载时本模块即被 import，监听器早已就位，
// 返回时 popstate 先于 Next.js 重挂载触发，标记不会丢。
let popAt = 0
let installed = false

function ensureListener(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('popstate', () => {
    popAt = Date.now()
  })
}

// 模块被 import 即安装（dashboard 在跳转前必然已挂载并 import 本文件）
ensureListener()

/** 列表 → 详情跳转前：记录精确滚动位置与当前分类筛选 */
export function saveDashboardState(y: number, filter: string): void {
  try {
    const state: DashboardScrollState = { y: Math.max(0, Math.round(y)), filter, savedAt: Date.now() }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // sessionStorage 不可用（隐私模式）时静默降级：返回走浏览器默认行为
  }
}

function readState(): DashboardScrollState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Partial<DashboardScrollState>
    if (typeof s.y !== 'number' || typeof s.savedAt !== 'number') return null
    if (Date.now() - s.savedAt > STALE_MS) return null
    return { y: s.y, filter: typeof s.filter === 'string' ? s.filter : '全部', savedAt: s.savedAt }
  } catch {
    return null
  }
}

/**
 * 判断本次挂载是否由「前进/后退」触发且存在有效记忆。
 * 读取即消费，避免后续侧边栏 push 挂载误用陈旧标记。
 */
export function consumeReturnNavigation(): { restore: boolean; state: DashboardScrollState | null } {
  const fresh = Date.now() - popAt < POP_FRESH_MS
  popAt = 0
  if (!fresh) return { restore: false, state: null }
  const state = readState()
  return { restore: state !== null, state }
}

/**
 * 在列表 DOM 渲染完成后调用：rAF 循环恢复滚动。
 * 每帧用「当前最新」页面高度重算可滚动上限（内容可能仍在增长），
 * 高度足够承载目标位置后立即停止；返回 cancel 函数供组件卸载时清理。
 */
export function restoreDashboardScroll(targetY: number): () => void {
  let raf = 0
  let frames = 0

  const tick = (): void => {
    frames += 1
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight
    window.scrollTo(0, Math.min(targetY, Math.max(0, maxScroll)))
    if (maxScroll >= targetY - 1 || frames >= RESTORE_MAX_FRAMES) return
    raf = requestAnimationFrame(tick)
  }

  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}

/**
 * 详情页统一返回逻辑：
 * - 有素材库记忆（说明从列表跳来）且历史栈可回退 → router.back()，走 popstate 触发精确恢复
 * - 直接访问/分享链接进入/历史栈为空 → push('/dashboard')，避免退出站点
 */
export function backToDashboard(router: {
  back: () => void
  push: (href: string) => void
}): void {
  const hasMemory = readState() !== null
  if (hasMemory && typeof window !== 'undefined' && window.history.length > 1) {
    router.back()
  } else {
    router.push('/dashboard')
  }
}
