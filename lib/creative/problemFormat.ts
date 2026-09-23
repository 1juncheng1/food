// ============================================================
// 问题理解的「纯」部分：兜底清洗 + 格式化
//
// 零运行时依赖（只 import type，编译期即被擦除），因此 'use client'
// 组件可以安全引用，不会把 ./blueprint（含 DeepSeek 调用）拖进浏览器 bundle。
// ============================================================

import type { ProblemUnderstanding } from './blueprint'

/** 问题理解兜底清洗：类型/目标/拆解三要素缺失即视为无效，调用方静默降级 */
export function normalizeProblem(raw: unknown): ProblemUnderstanding | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const s = (v: unknown, max: number): string =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''

  const tasks = Array.isArray(o.task_breakdown)
    ? o.task_breakdown
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter(Boolean)
        .slice(0, 6)
    : []

  const p: ProblemUnderstanding = {
    problem_type: s(o.problem_type, 60),
    is_content_creation: o.is_content_creation === true,
    user_goal: s(o.user_goal, 200),
    task_breakdown: tasks,
    user_identity: s(o.user_identity, 200),
    recommended_role: s(o.recommended_role, 200),
    role_reason: s(o.role_reason, 200),
    success_criteria: s(o.success_criteria, 200),
    professional_prompt: s(o.professional_prompt, 1500),
    // 阶段 3：scenario 可选字段，有值才挂
    ...(s(o.scenario, 100) ? { scenario: s(o.scenario, 100) } : {}),
  }
  if (!p.problem_type || !p.user_goal || p.task_breakdown.length === 0) return null
  return p
}

/** 把问题理解格式化为注入 LLM 的文本块（随蓝图一起注入生成调用） */
export function formatProblemForPrompt(pu: ProblemUnderstanding): string {
  const lines: string[] = [
    `问题类型：${pu.problem_type}`,
    `用户真实目标：${pu.user_goal}`,
  ]
  if (pu.scenario) lines.push(`使用场景：${pu.scenario}（内容风格需适配此场景）`)
  if (pu.task_breakdown.length > 0) {
    lines.push('需要解决的核心任务：')
    lines.push(...pu.task_breakdown.map((t, i) => `  ${i + 1}. ${t}`))
  }
  if (pu.user_identity) lines.push(`用户身份：${pu.user_identity}`)
  if (pu.recommended_role) lines.push(`AI 应扮演的角色：${pu.recommended_role}`)
  if (pu.success_criteria) lines.push(`成功标准：${pu.success_criteria}`)
  return `【问题理解（用户的真实目标，优先于文案技巧）】\n${lines.join('\n')}`
}
