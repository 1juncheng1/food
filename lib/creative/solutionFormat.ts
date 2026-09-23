// ============================================================
// 解决方案的「纯」部分：兜底清洗 + Markdown 格式化
//
// 零运行时依赖（只 import type，编译期即被擦除），因此 'use client'
// 组件可以安全引用，不会把 ./problemSolver（含 DeepSeek 调用）拖进浏览器 bundle。
// ============================================================

import type { SolutionResult, SolutionSection } from './problemSolver'

/** 兜底清洗：标题与至少一个有效章节缺失即视为无效，调用方降级 */
export function normalizeSolution(raw: unknown): SolutionResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const s = (v: unknown, max: number): string =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''

  const sections = Array.isArray(o.sections)
    ? o.sections
        .slice(0, 8)
        .map((sec) => {
          if (typeof sec !== 'object' || sec === null) return null
          const so = sec as Record<string, unknown>
          const heading = s(so.heading, 80)
          const content = s(so.content, 6000)
          return content ? { heading: heading || '未命名章节', content } : null
        })
        .filter((sec): sec is SolutionSection => sec !== null)
    : []

  const nextSteps = Array.isArray(o.next_steps)
    ? o.next_steps
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter(Boolean)
        .slice(0, 5)
        .map((x) => x.slice(0, 150))
    : []

  const result: SolutionResult = {
    title: s(o.title, 120),
    summary: s(o.summary, 400),
    sections,
    next_steps: nextSteps,
    success_check: s(o.success_check, 300),
  }
  if (!result.title || result.sections.length === 0) return null
  return result
}

/** 把结构化方案拼成完整 Markdown 纯文本（localStorage 落盘 + 一键复制用） */
export function formatSolutionFullText(result: SolutionResult): string {
  const parts: string[] = [`# ${result.title}`]
  if (result.summary) parts.push(result.summary)
  result.sections.forEach((sec, i) => {
    parts.push(`\n## ${i + 1}. ${sec.heading}\n${sec.content}`)
  })
  if (result.next_steps.length > 0) {
    parts.push(`\n## 下一步行动`)
    result.next_steps.forEach((step, i) => parts.push(`${i + 1}. ${step}`))
  }
  if (result.success_check) {
    parts.push(`\n## 成功自检\n${result.success_check}`)
  }
  return parts.join('\n\n')
}
