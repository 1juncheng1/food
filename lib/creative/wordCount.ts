// ============================================================
// 目标字数（自定义字数）—— 纯常量 + 纯函数
//
// 单独成模块的原因：生成页是 'use client'，需要拿到与服务端完全一致的
// 上下界做即时校验，而 lib/creative/plan.ts 内含 LLM 调用（服务端模块），
// 不能进客户端包。这里只放常量与清洗函数，两端共用同一口径。
// ============================================================

/** 目标字数下限（低于此值不具备成篇价值） */
export const WORD_COUNT_MIN = 100
/** 目标字数上限（超过此值单次生成会被截断，且信息密度必然稀释） */
export const WORD_COUNT_MAX = 5000

/** 清洗用户输入：非法 / 越界返回 null（= 交给 AI 判断） */
export function clampWordCount(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const rounded = Math.round(n)
  return rounded >= WORD_COUNT_MIN && rounded <= WORD_COUNT_MAX ? rounded : null
}
