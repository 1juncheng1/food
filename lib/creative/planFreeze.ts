// ============================================================
// 方案冻结（freezePlan）—— 纯函数，无 LLM / IO
//
// 单独成模块是为了让生成页（'use client'）能直接引用它，
// 而不必 import ./plan（后者含 DeepSeek 调用，属服务端模块）。
// 只 import type，编译期即被擦除，不产生运行时依赖。
// ============================================================

import type { CreativePlan, PlanEdits, PlanLanguageStyle, FrozenPlan } from './plan'
import type { ClarificationAnswer } from './intentClarity'

/**
 * 冻结创作方案：把（可能被用户编辑过的）方案压平成落库的 FrozenPlan。
 * 前端在点击"使用方案，生成文章"时调用。
 *
 * 阶段 3：clarifications 来自用户澄清面板的原始回答。
 * - 直接挂到 FrozenPlan.clarifications 落库（供跨设备恢复）
 * - 同时把 clarifications 中的 scenario 注入 problem_understanding
 *   （AI 可能没输出 scenario，但用户明确说了使用场景）
 */
export function freezePlan(
  plan: CreativePlan,
  edits?: PlanEdits,
  clarifications?: ClarificationAnswer[]
): FrozenPlan {
  const selectedKey = edits?.directionKey ?? plan.recommended_direction_key
  const direction = plan.directions.find((d) => d.key === selectedKey) ?? plan.directions[0]

  const languageStyle: PlanLanguageStyle = {
    pace: edits?.languageStyle?.pace ?? direction.language_style.pace,
    mood: edits?.languageStyle?.mood ?? direction.language_style.mood,
    expression: edits?.languageStyle?.expression ?? direction.language_style.expression,
  }

  const viewpoint = edits?.viewpoint?.trim() || direction.viewpoint
  const contentType = edits?.contentType?.trim() || plan.content_type

  // 阶段 3：从 clarifications 中提取 scenario，覆盖 problem_understanding.scenario
  // 用户明确说了"使用场景=小红书"，AI 不能把它改成"公众号"——用户回答优先于 AI 推断
  let problemUnderstanding = plan.problem
  if (problemUnderstanding && clarifications?.length) {
    const scenarioAnswer = clarifications.find((c) => c.dimension === 'scenario')
    if (scenarioAnswer?.answer) {
      problemUnderstanding = {
        ...problemUnderstanding,
        scenario: scenarioAnswer.answer,
      }
    }
  }

  return {
    // ── 旧蓝图字段（进化系统/版本/诊断继续读这些）──
    title_direction: direction.title,
    positioning: direction.desc ? `${direction.title}：${direction.desc}` : direction.title,
    target_audience: plan.target_audience,
    structure: direction.structure,
    emotion_curve: direction.emotion_curve,
    opening_hook: direction.opening_hook,
    core_conflict: direction.core_conflict,
    ending: direction.ending,
    strategy: direction.strategy,
    persona_hint: viewpoint,
    // ── 超集新字段 ──
    content_type: contentType,
    language_style: languageStyle,
    // 内容战略块随冻结方案落库（"为什么这样写"的战略决策记录）
    ...(plan.strategy ? { content_strategy: plan.strategy } : {}),
    ...(direction.strategy_mode ? { strategy_mode: direction.strategy_mode } : {}),
    // 市场约束随冻结方案落库，进入正文生成 prompt 作为硬约束
    ...(plan.market_constraints ? { market_constraints: plan.market_constraints } : {}),
    word_count: edits?.wordCount ?? plan.recommended_word_count,
    // 阶段 3：AI 推断的素材用途标签（替代 CATEGORY_TO_USAGE 映射）
    ...(plan.usage_tag ? { usage_tag: plan.usage_tag } : {}),
    // 问题理解随冻结方案落库（generation_history.blueprint jsonb，零表结构变更）
    problem_understanding: problemUnderstanding,
    // 阶段 3：用户澄清回答原始值（跨设备恢复用）
    ...(clarifications?.length ? { clarifications } : {}),
  }
}
