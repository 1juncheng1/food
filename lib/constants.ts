// 全局分类常量：前端选项与后端校验共用，避免多处重复定义导致不同步
export const CATEGORIES = [
  '电影解说',
  '短剧解说',
  '纪录片解说',
  '动漫解说',
  '故事文案',
  '读书解读',
  '科普解说',
  '剧本打磨',
  '其他',
] as const

export type Category = (typeof CATEGORIES)[number]

/** 校验并转换分类值，非法值返回 null */
export function toCategory(value: unknown): Category | null {
  if (typeof value !== 'string') return null
  return (CATEGORIES as readonly string[]).includes(value) ? (value as Category) : null
}
