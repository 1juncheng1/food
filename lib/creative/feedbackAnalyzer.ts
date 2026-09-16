// ============================================================
// Feedback Analyzer（反馈分析器）—— Work Agent 阶段 3
//
// 把用户的自由文本反馈（如"不够震撼""开头不够吸引人"）
// 翻译为结构化 Optimization Blueprint，供下一版生成时注入 prompt。
//
// 输出：FeedbackAnalysis
//   - intentType：6 类优化方向之一（hit/style/emotion/depth/video/script/custom）
//   - modificationTargets：具体修改点 2-5 个
//   - optimizationBlueprint：可直接注入下一版生成的优化蓝图片段
//   - userIntentSummary：AI 对用户反馈的一句话理解（展示给用户确认）
//
// 设计原则：
//   1. 失败静默降级：返回 null 时调用方直接把 freeText 作为 instruction 走 custom 方向
//   2. 不调起新版本生成：只分析，不触发 LLM 生成
//   3. 重试 3 次：JSON 解析失败时重试，提高稳定性
// ============================================================

import { normalizeFeedbackAnalysis, type FeedbackAnalysis } from './workAgent'

// ── 类型与常量 ────────────────────────────────────────────

export interface AnalyzeFeedbackInput {
  /** 用户自由反馈原文（如"开头不够吸引人""不够震撼"） */
  freeText: string
  /** 当前作品正文（截断 6000 字，让 AI 知道在改什么） */
  currentContent: string
  /** 创作主题（辅助判断） */
  topic?: string
  /** 当前版本的 AI 诊断报告（jsonb，可选——让 AI 知道当前作品的诊断结果） */
  diagnosis?: unknown
}

const FEEDBACK_JSON_KEYS = [
  'intent_type',
  'modification_targets',
  'optimization_blueprint',
  'user_intent_summary',
  'impact_scope',
  'preserve_items',
].join(', ')

// ── Prompt 构造 ───────────────────────────────────────────

function buildSystemPrompt(): string {
  return [
    '你是创作反馈分析专家。用户给出一篇已生成作品和一条自由反馈，',
    '你需要把反馈翻译为结构化的优化蓝图，供下一版生成时注入。',
    '',
    '6 类优化方向（intent_type 必须是其中之一）：',
    '1. hit：爆款内容优化——提升传播力、开头钩子、冲突强度',
    '2. style：风格强化——改变表达方式、文风、口吻',
    '3. emotion：情感增强——提升情绪强度、情感共鸣',
    '4. depth：深度升级——增加案例、数据、逻辑深度',
    '5. video：短视频改编——改为短视频脚本结构',
    '6. script：脚本转换——改为演讲/口播稿',
    '7. custom：用户自定义修改——其他无法归类的修改需求',
    '',
    '分析规则：',
    '- 反馈原文优先于你的判断：用户明确说了改什么，就改什么；',
    '- modification_targets 是从反馈中提取的具体修改点（2-5 个），如"开头冲突""情绪曲线""案例数量"；',
    '- optimization_blueprint 是可直接注入下一版生成的优化指令（100-300 字自然语言）；',
    '- user_intent_summary 是一句话向用户确认你的理解（如"你希望增强开头冲突，提高情绪强度"）；',
    '- 不要编造用户没说的修改点；',
    '- 反馈模糊时（如"不够好"），把 modification_targets 写为["整体质量提升"]，',
    '  optimization_blueprint 写为"在保持主题和结构不变的前提下，整体提升内容质量"。',
    '',
    '硬性输出要求：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释或前后缀文字；',
    '2. 所有字符串字段使用中文；',
    '3. JSON 必须严格包含以下 key：',
    FEEDBACK_JSON_KEYS,
    '   intent_type 的值只能从 hit/style/emotion/depth/video/script/custom 中取；',
    '   modification_targets 是字符串数组，2-5 个元素；',
    '   optimization_blueprint 和 user_intent_summary 必须有值。',
    '4. impact_scope 是影响范围枚举数组（1-3 个元素），只能从',
    '   ["开头","背景","核心内容","高潮","结尾","全篇"] 中取，表示本次反馈指向的文章区域；',
    '5. preserve_items 是字符串数组（2-4 个元素），列出本次修改必须保持不变的内容，',
    '   如"故事主题""人物关系""整体结构""叙述视角"，其中"故事主题与整体结构"必须包含。',
  ].join('\n')
}

function buildUserPrompt(input: AnalyzeFeedbackInput): string {
  const lines: string[] = [
    '请分析以下用户反馈，输出结构化优化蓝图：',
    '',
    `用户反馈原文：${input.freeText}`,
    '',
    `创作主题：${input.topic || '（未提供）'}`,
  ]
  if (input.diagnosis) {
    lines.push(
      '',
      '--- 当前版本 AI 诊断（参考，帮助你定位问题）---',
      JSON.stringify(input.diagnosis).slice(0, 2000),
      '--- 诊断结束 ---'
    )
  }
  lines.push(
    '',
    '--- 当前作品正文（截断 6000 字）---',
    input.currentContent.slice(0, 6000),
    '--- 正文结束 ---'
  )
  return lines.join('\n')
}

// ── LLM 调用 ──────────────────────────────────────────────

/**
 * 调用 DeepSeek 分析用户反馈（强制 JSON 输出）。
 * 仅服务端使用；失败返回 null，调用方降级为"直接把 freeText 作为 instruction 走 custom 方向"。
 *
 * 温度 0.4：反馈分析需要一定创造性（提取修改点），但不能偏离用户原意。
 * max_tokens 800：输出远短于正文生成，节省成本。
 */
export async function analyzeFeedback(
  input: AnalyzeFeedbackInput
): Promise<FeedbackAnalysis | null> {
  const freeText = input.freeText.trim()
  if (freeText.length < 2) return null // 反馈过短无法分析
  if (freeText.length > 2000) return null // 反馈过长视为异常

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
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: buildUserPrompt(input) },
          ],
          temperature: 0.4,
          max_tokens: 800,
          response_format: { type: 'json_object' },
        }),
      })

      if (!res.ok) {
        console.error('反馈分析失败:', await res.text())
        return null
      }
      const data = await res.json()
      const raw: string = data?.choices?.[0]?.message?.content ?? ''
      if (!raw.trim()) return null

      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
      const parsed = normalizeFeedbackAnalysis(JSON.parse(cleaned))
      if (parsed) return parsed
    } catch (e) {
      console.error(`反馈分析异常（第 ${attempt + 1} 次）:`, e)
    }
  }
  return null
}
