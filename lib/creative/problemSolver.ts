// ============================================================
// Problem Solver（通用问题求解适配器）—— 2a：非内容类问题的成品生成
//
// 与正文生成（prompt-optimizer）的区别：
//   输入不是创作主题，而是第一阶段的问题理解（ProblemUnderstanding）。
//   适配器是"通用"的：不枚举问题类型（商业计划书/学习计划…），
//   而是由 AI 按 task_breakdown 生成对应章节的结构化交付物——
//   任何非内容类问题都能解，新增类型零代码成本。
//
// 纯类型 + 纯函数 + 服务端 LLM 调用，前端只 import 类型与格式化工具。
// ============================================================

import type { ProblemUnderstanding } from './blueprint'

/** 解决方案的一个章节（一个章节至少覆盖一项核心任务） */
export interface SolutionSection {
  heading: string
  content: string
}

/** 结构化解决方案交付物 */
export interface SolutionResult {
  title: string // 交付物标题
  summary: string // 一句话方案思路
  sections: SolutionSection[] // 3-7 个章节，覆盖全部核心任务
  next_steps: string[] // 用户拿到方案后应立即执行的行动（3-5 条）
  success_check: string // 对照成功标准的自检方式
}

/** 补强说明：AI 对照成功标准审视上一版后的诊断结论 */
export interface StrengthenReview {
  note: string // 本版主要补强了什么（一句话）
  gaps: string[] // 上一版对照成功标准的具体不足（2-4 条）
}

/** 补强结果：新版方案 + 评审说明 */
export interface StrengthenOutcome {
  result: SolutionResult
  review: StrengthenReview
}

/** 解决方案的一个历史版本（前端存储用；V1 无 note/gaps） */
export interface SolutionVersion {
  result: SolutionResult
  createdAt: string
  note?: string // 本版补强说明（V1 无）
  gaps?: string[] // 生成该版时发现的上一版不足（V1 无）
}

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

/**
 * 调用 DeepSeek 生成结构化解决方案（强制 JSON）。
 * 仅服务端使用；失败返回 null，调用方返回 502，前端可重试。
 * LLM 偶发返回非合法 JSON（长输出截断时），最多尝试 3 次。
 */
export async function generateSolution(input: {
  topic: string
  problem: ProblemUnderstanding
}): Promise<SolutionResult | null> {
  const { topic, problem } = input

  const system = [
    `${problem.recommended_role}。你的任务：针对用户提出的问题，产出一套结构化、可直接使用的解决方案交付物（不是建议清单，而是成文文档）。`,
    '硬性要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    '2. JSON 必须严格包含以下 key：title, summary, sections, next_steps, success_check；',
    '3. title：交付物标题（≤30 字）；summary：一句话概述整体方案思路；',
    '4. sections：3-7 个章节，必须覆盖下方全部核心任务（每项任务至少对应一个章节，相近任务可整合）；',
    '   sections 的每一项必须是对象且严格包含两个 key：heading（章节标题，8-20 字，概括该章解决什么）和 content（完整成文正文）；',
    '   content 要具体、可执行、有数据或示例支撑，每章 250-600 字、禁止一两句话带过，禁止"应该重视""需要加强"这类空话；',
    '   全部章节合计 1500-3000 字，语言专业、贴合用户身份所需的表达方式；',
    '5. next_steps：3-5 条用户拿到方案后应立即执行的行动，每条具体可操作；',
    '6. success_check：对照成功标准，给出用户完成方案后的自检方式（一段话）；',
    '7. 所有内容使用中文。',
  ].join('\n')

  const user = `用户的问题：${topic}

问题类型：${problem.problem_type}
用户真实目标：${problem.user_goal}
用户身份：${problem.user_identity || '未明确'}
需要解决的核心任务：
${problem.task_breakdown.map((t, i) => `${i + 1}. ${t}`).join('\n')}
成功标准：${problem.success_criteria || '方案完整、可直接使用'}`

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.5,
          max_tokens: 7000,
          response_format: { type: 'json_object' },
        }),
      })

      if (!res.ok) {
        console.error('解决方案生成失败:', await res.text())
        return null
      }
      const data = await res.json()
      const text: string = data?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim()) return null

      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const parsed = normalizeSolution(JSON.parse(cleaned))
      if (parsed) return parsed
      // normalizeSolution 返回 null 说明字段不全，重试
    } catch (e) {
      console.error(`解决方案生成异常（第 ${attempt + 1} 次）:`, e)
    }
  }
  return null
}

/**
 * 补强输出兜底清洗。兼容两种返回形态：
 *   嵌套：{ review: {...}, solution: {...} }
 *   平铺：{ note, gaps, title, summary, sections... }（模型偶发漏嵌套时）
 * review 与 solution 均有效才通过，否则触发上层重试。
 */
export function normalizeStrengthen(raw: unknown): StrengthenOutcome | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const s = (v: unknown, max: number): string =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''

  const hasNested = typeof o.solution === 'object' && o.solution !== null
  const solutionRaw = hasNested ? o.solution : raw
  const reviewRaw = (typeof o.review === 'object' && o.review !== null)
    ? (o.review as Record<string, unknown>)
    : hasNested
      ? null
      : o

  const result = normalizeSolution(solutionRaw)
  if (!result) return null

  const r = (reviewRaw ?? {}) as Record<string, unknown>
  const gaps = Array.isArray(r.gaps)
    ? r.gaps
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter(Boolean)
        .slice(0, 4)
        .map((x) => x.slice(0, 200))
    : []
  const note = s(r.note, 200)
  if (!note && gaps.length === 0) return null
  return { result, review: { note: note || '已对照成功标准补强方案', gaps } }
}

/**
 * 补强迭代：以评审视角对照成功标准审视当前版，产出具名不足 + 补强新版。
 * 仅服务端使用；失败返回 null，调用方返回 502，前端可重试。
 */
export async function strengthenSolution(input: {
  topic: string
  problem: ProblemUnderstanding
  previous: SolutionResult
}): Promise<StrengthenOutcome | null> {
  const { topic, problem, previous } = input

  const system = [
    `${problem.recommended_role}。用户此前已获得你产出的一版解决方案。你的任务：以严格的评审视角，对照成功标准找出这一版的具体不足，然后产出一版补强后的新方案。`,
    '硬性要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    '2. JSON 结构必须为 { "review": { "note": "", "gaps": [] }, "solution": { "title": "", "summary": "", "sections": [], "next_steps": [], "success_check": "" } }；',
    '3. review.note：一句话说明新版主要补强了什么；review.gaps：2-4 条上一版对照成功标准的具体不足（必须指明具体章节或内容缺陷，禁止"内容不够好"式空话）；',
    '4. solution 为补强后的完整新版方案：sections 3-7 个章节，每项必须是对象且严格包含两个 key：heading（章节标题，8-20 字）和 content（完整成文正文）；',
    '5. 上一版中已达标的内容保留（可优化措辞），集中火力补齐 review 指出的不足；每章 250-600 字、禁止一两句话带过，全部章节合计 1500-3000 字；',
    '6. content 具体、可执行、有数据或示例支撑，禁止"应该重视""需要加强"这类空话；next_steps 3-5 条每条具体可操作；success_check 为一段话；',
    '7. 所有内容使用中文。',
  ].join('\n')

  const user = `用户的问题：${topic}

问题类型：${problem.problem_type}
用户真实目标：${problem.user_goal}
用户身份：${problem.user_identity || '未明确'}
成功标准：${problem.success_criteria || '方案完整、可直接使用'}

当前版本方案（待补强）：
${JSON.stringify(previous, null, 2)}`

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.5,
          max_tokens: 7000,
          response_format: { type: 'json_object' },
        }),
      })

      if (!res.ok) {
        console.error('方案补强失败:', await res.text())
        return null
      }
      const data = await res.json()
      const text: string = data?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim()) return null

      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const parsed = normalizeStrengthen(JSON.parse(cleaned))
      if (parsed) return parsed
      // normalizeStrengthen 返回 null 说明结构不全，重试
    } catch (e) {
      console.error(`方案补强异常（第 ${attempt + 1} 次）:`, e)
    }
  }
  return null
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
