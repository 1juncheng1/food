// 灵感广场社区化：内容展示的公共格式化工具
// 广场 / 详情 / 作者主页共用，避免三处各写一套摘要/时间口径

/** 去掉图片帖尾部追加的 [图片描述] 段 */
export function stripImageDescription(content: string): string {
  return content.replace(/\n*\s*\[图片描述\][\s\S]*$/, '').trim()
}

/** 取出图片描述段（无则返回 null） */
export function getImageDescription(content: string): string | null {
  const match = content.match(/\[图片描述\]\s*([\s\S]+)$/)
  return match ? match[1].trim() : null
}

/**
 * 从正文提取「标题 + 摘要」。
 * posts 表没有 title 字段，普通灵感帖按社区惯例取首段作标题：
 *   - 首段 ≤ 40 字 → 作为标题，其余为摘要
 *   - 首段 > 40 字 → 标题取前 24 字，正文整体作摘要
 */
export function extractTitleAndSummary(
  content: string,
  opts: { titleMax?: number; summaryMax?: number } = {}
): { title: string; summary: string } {
  const titleMax = opts.titleMax ?? 40
  const summaryMax = opts.summaryMax ?? 180

  const clean = stripImageDescription(content) || content.trim()
  if (!clean) return { title: '', summary: '' }

  const [firstLine, ...rest] = clean.split('\n')
  const first = firstLine.trim()
  const remainder = rest.join('\n').trim()

  if (first.length <= titleMax) {
    return {
      title: first,
      summary: remainder.length > summaryMax ? remainder.slice(0, summaryMax) + '…' : remainder,
    }
  }

  // 首段过长：整段当摘要，标题截前 24 字
  return {
    title: first.slice(0, 24) + '…',
    summary: clean.length > summaryMax ? clean.slice(0, summaryMax) + '…' : clean,
  }
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期 */
export function timeAgo(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000)
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 2592000) return `${Math.floor(diff / 86400)} 天前`
  return date.toLocaleDateString('zh-CN')
}

/** 完整时间（详情页用） */
export function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 昵称首字符（头像降级用） */
export function initialOf(name: string | null | undefined): string {
  const n = (name ?? '').trim()
  if (!n) return 'U'
  return n[0].toUpperCase()
}
