// 社区内容格式化：标题/摘要/相对时间的口径测试
// 这些规则被广场、详情、作者主页共用，改一处会影响三处展示，必须有断言兜底。

import { describe, expect, it } from 'vitest'
import {
  extractTitleAndSummary,
  getImageDescription,
  initialOf,
  stripImageDescription,
  timeAgo,
} from './format'

describe('extractTitleAndSummary', () => {
  it('首段短 → 作为标题，其余为摘要', () => {
    const r = extractTitleAndSummary('雨天的便利店\n门口的猫蹲了很久')
    expect(r.title).toBe('雨天的便利店')
    expect(r.summary).toBe('门口的猫蹲了很久')
  })

  it('首段过长 → 标题截前 24 字并加省略号，正文整体作摘要', () => {
    const long = '一'.repeat(60)
    const r = extractTitleAndSummary(long)
    expect(r.title).toBe('一'.repeat(24) + '…')
    expect(r.summary).toBe(long)
  })

  it('摘要超长 → 截断到 180 字并加省略号', () => {
    const r = extractTitleAndSummary('标题\n' + '字'.repeat(300))
    expect(r.summary).toHaveLength(181) // 180 + '…'
    expect(r.summary.endsWith('…')).toBe(true)
  })

  it('图片帖：标题/摘要都不含 [图片描述] 段', () => {
    const r = extractTitleAndSummary('海边的黄昏\n\n[图片描述]\n一张夕阳照片')
    expect(r.title).toBe('海边的黄昏')
    expect(r.summary).not.toContain('图片描述')
  })
})

describe('图片描述段', () => {
  it('getImageDescription 取出描述；无则 null', () => {
    expect(getImageDescription('正文\n[图片描述]\n落日与海')).toBe('落日与海')
    expect(getImageDescription('普通正文')).toBeNull()
  })

  it('stripImageDescription 去掉尾部描述段且保留正文', () => {
    expect(stripImageDescription('正文\n[图片描述]\n落日与海')).toBe('正文')
    expect(stripImageDescription('正文')).toBe('正文')
  })
})

describe('timeAgo', () => {
  const at = (secAgo: number) => new Date(Date.now() - secAgo * 1000).toISOString()

  it('分钟/小时/天 分档', () => {
    expect(timeAgo(at(10))).toBe('刚刚')
    expect(timeAgo(at(120))).toBe('2 分钟前')
    expect(timeAgo(at(7200))).toBe('2 小时前')
    expect(timeAgo(at(86400 * 3))).toBe('3 天前')
  })
})

describe('initialOf', () => {
  it('空昵称降级为 U；英文首字母大写', () => {
    expect(initialOf(null)).toBe('U')
    expect(initialOf('  ')).toBe('U')
    expect(initialOf('ada')).toBe('A')
    expect(initialOf('创作者')).toBe('创')
  })
})
