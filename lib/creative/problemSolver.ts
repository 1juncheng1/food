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
import { callDeepSeekChat, llmTimeoutMs, stripJsonFence } from '@/lib/llm'
import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeSolution } from './solutionFormat'

/**
 * 计费上下文：传了才计费（「预扣 → 按真实用量结算 → 失败全退」）。
 * 方案生成是重量级输出（1500-3000 字），按 generation 档预扣。
 */
export type SolutionBilling = { supabase: SupabaseClient; userId: string; refId?: string }

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

// 方案的兜底清洗与 Markdown 格式化是纯函数，已抽到 ./solutionFormat（零运行时依赖），
// 以便 'use client' 组件引用时不会把本文件（含 DeepSeek 调用）拖进浏览器 bundle。
// 此处再导出以保持既有调用方不变。
export { normalizeSolution, formatSolutionFullText } from './solutionFormat'

/**
 * 调用 DeepSeek 生成结构化解决方案（强制 JSON）。
 * 仅服务端使用；失败返回 null，调用方返回 502，前端可重试。
 * LLM 偶发返回非合法 JSON（长输出截断时），最多尝试 3 次。
 */
export async function generateSolution(
  input: {
    topic: string
    problem: ProblemUnderstanding
  },
  billing?: SolutionBilling
): Promise<SolutionResult | null> {
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
      const res = await callDeepSeekChat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.5,
        max_tokens: 7000,
        jsonMode: true,
        timeoutMs: llmTimeoutMs(7000),
        // 计费：3 次尝试各用各的 refId——复用会让第 2 次起被判重复预扣（reserved=0）
        ...(billing
          ? {
              billing: {
                supabase: billing.supabase,
                userId: billing.userId,
                ability: 'generation' as const,
                refId: `${billing.refId ?? crypto.randomUUID()}:solution:${attempt}`,
                description: '解决方案生成',
              },
            }
          : {}),
      })

      if (!res.ok) {
        // 余额不足不会走到这里：预扣失败在发起 HTTP 前就返回了，一个 token 都没花
        console.error('解决方案生成失败:', res.error)
        return null
      }
      const parsed = normalizeSolution(JSON.parse(stripJsonFence(res.content)))
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
export async function strengthenSolution(
  input: {
    topic: string
    problem: ProblemUnderstanding
    previous: SolutionResult
  },
  billing?: SolutionBilling
): Promise<StrengthenOutcome | null> {
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
      const res = await callDeepSeekChat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.5,
        max_tokens: 7000,
        jsonMode: true,
        timeoutMs: llmTimeoutMs(7000),
        // 计费：3 次尝试各用各的 refId——复用会让第 2 次起被判重复预扣（reserved=0）
        ...(billing
          ? {
              billing: {
                supabase: billing.supabase,
                userId: billing.userId,
                ability: 'generation' as const,
                refId: `${billing.refId ?? crypto.randomUUID()}:strengthen:${attempt}`,
                description: '方案补强',
              },
            }
          : {}),
      })

      if (!res.ok) {
        // 余额不足不会走到这里：预扣失败在发起 HTTP 前就返回了，一个 token 都没花
        console.error('方案补强失败:', res.error)
        return null
      }
      const parsed = normalizeStrengthen(JSON.parse(stripJsonFence(res.content)))
      if (parsed) return parsed
      // normalizeStrengthen 返回 null 说明结构不全，重试
    } catch (e) {
      console.error(`方案补强异常（第 ${attempt + 1} 次）:`, e)
    }
  }
  return null
}

