/**
 * 全站统一的「AI 正在工作」文案与状态常量。
 *
 * 铁律：
 * 1. 任何面向用户的 AI 进行中文案都必须从这里取，禁止在页面里写死「加载中」「处理中」。
 * 2. 文案统一用中文省略号「…」。
 * 3. 文案描述的是「AI 在理解你什么」，而不是「系统在跑什么任务」。
 */

export type AiTaskKey =
  | 'inspiration'
  | 'generate'
  | 'plan'
  | 'diagnose'
  | 'revise'
  | 'knowledge'
  | 'material'
  | 'profile'
  | 'community'
  | 'publish'

/** 每个任务的分步文案（按顺序推进，展示给用户 = AI 的思考过程可见） */
export const AI_TASK_STEPS: Record<AiTaskKey, readonly string[]> = {
  inspiration: [
    '正在读取你的创作方向…',
    '正在匹配你的知识库…',
    '正在挑选值得创作的机会…',
  ],
  generate: [
    '正在理解你想解决的问题…',
    '正在设计差异化的创作方向…',
    '正在匹配你的叙事结构与语言风格…',
  ],
  plan: [
    '正在理解你的创作目标…',
    '正在参考你的风格与知识…',
    '正在组织可执行的创作方案…',
  ],
  diagnose: [
    '正在通读你的作品…',
    '正在核对观点与证据…',
    '正在评估表达效果…',
  ],
  revise: [
    '正在理解你的修改意图…',
    '正在生成修改方案…',
    '正在核对改动是否符合你的方向…',
  ],
  knowledge: [
    '正在归纳你的素材…',
    '正在提炼可复用的知识…',
    '正在关联你的创作…',
  ],
  material: [
    '正在理解这段素材…',
    '正在提取可用观点…',
    '正在归入你的知识领域…',
  ],
  profile: [
    '正在分析你的表达特点…',
    '正在识别你的关注领域…',
    '正在评估你的知识优势…',
  ],
  community: [
    '正在理解社区里的新想法…',
    '正在匹配与你相关的创作者…',
  ],
  publish: [
    '正在整理你的灵感…',
    '正在提炼可分享的观点…',
  ],
}

/** AI 空闲时的状态说明（让用户知道 AI 随时待命，而不是"没有 AI"） */
export const AI_IDLE_HINT: Record<AiTaskKey, string> = {
  inspiration: 'AI 已就绪，随时为你发现新的创作机会',
  generate: 'AI 已就绪，等你提出想做的事',
  plan: 'AI 已就绪，会参考你的风格与知识来组织方案',
  diagnose: 'AI 随时可以再读一遍你的作品',
  revise: '告诉 AI 哪里不满意，它会先确认你的意思再动手',
  knowledge: 'AI 已就绪，会持续把你的素材沉淀成知识',
  material: 'AI 已就绪，随时理解你新增的素材',
  profile: 'AI 已读懂你的创作特征',
  community: 'AI 已就绪，帮你找到相关的创作者',
  publish: 'AI 已就绪，帮你整理灵感',
}

/** 取某一步文案（越界时回退到最后一步） */
export function aiStepText(task: AiTaskKey, step: number): string {
  const steps = AI_TASK_STEPS[task]
  if (!steps.length) return '正在理解你的创作…'
  return steps[Math.min(Math.max(step, 0), steps.length - 1)]
}

/** 通用兜底：未知任务也绝不出现「加载中」 */
export const AI_FALLBACK_TEXT = '正在理解你的创作…'
