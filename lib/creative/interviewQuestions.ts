// ============================================================
// Interview Questions —— AI 创作者访谈问题库
//
// 设计原则：
//   1. 每个问题必须影响 AI 生成（不问无关问题）
//   2. 优先选择式问题（降低用户思考成本），允许自定义输入
//   3. 6 类问题映射 8 个 CreatorDeclaration 字段
//   4. 总问题数 8-12 个，每类 1-2 问
//   5. 问题文本具体可感（不问"请输入你的需求"这种开放式问题）
//
// 问题分类：
//   1. 创作目的     → creator_goal
//   2. 表达方式     → expression_profile
//   3. 思考方式     → thinking_profile
//   4. 叙事偏好     → narrative_preference
//   5. 情绪倾向     → emotional_preference
//   6. 好作品标准   → quality_standard
//   7. 排斥因素     → avoid_preference（硬约束）
//   8. 创作场景     → creation_scenario
// ============================================================

import type { DeclarationDimension } from './creatorDeclaration'

// ── 类型定义 ───────────────────────────────────────────────

export interface InterviewOption {
  /** 选项值（存入 CreatorDeclaration 对应字段） */
  value: string
  /** 展示文本 */
  label: string
  /** 选项说明（hover/小字解释） */
  description?: string
}

export interface InterviewQuestion {
  /** 问题 id（前端用作 key） */
  id: string
  /** 对应的 DeclarationDimension（回答存入此字段） */
  dimension: DeclarationDimension
  /** 问题分类（6 类之一） */
  category: string
  /** 问题文本 */
  question: string
  /** 选项列表（2-4 个） */
  options: InterviewOption[]
  /** 是否允许自定义输入 */
  allowCustom: boolean
  /** 问题说明（可选，展示在问题下方） */
  hint?: string
}

// ── 8 类问题（共 10 问，每类 1-2 问）────────────────────────

export const INTERVIEW_QUESTIONS: InterviewQuestion[] = [
  // ── 类别 0：我是谁（3 问，2026-09-24 新增，排在写法维度之前）──
  //
  // 存在理由：原有 8 维全部是「怎么写」，没有一个维度回答「这个人是谁」。
  // 没有经历 / 价值判断 / 长期目标，AI 只能模仿语气，无法判断用户为什么在意
  // 某个话题。这三问是 Creator Memory 里最缺、也最难从行为反推的一块
  // ——行为能推断"喜欢什么写法"，推不出"凭什么谈、相信什么、要去哪"。
  //
  // 这三问对已访谈老用户走「增量补问」（见 interviewTrigger），不会要求重答 13 问。
  {
    id: 'background_main',
    dimension: 'background',
    category: '经历背景',
    question: '你在这个领域，凭什么谈这些话题？',
    hint: '这决定 AI 可以调用哪些亲身论据，以及内容的可信度基线',
    allowCustom: true,
    options: [
      { value: '一线从业者', label: '一线从业者', description: '正在做，有实操经验' },
      { value: '长期研究者', label: '长期研究者', description: '系统研究过，有方法论' },
      { value: '亲身经历者', label: '亲身经历者', description: '经历过，有第一手感受' },
      { value: '跨界观察者', label: '跨界观察者', description: '从别的领域看过来，视角独特' },
    ],
  },
  {
    id: 'value_main',
    dimension: 'value_statement',
    category: '价值判断',
    question: '你最坚持的一条判断是什么？',
    hint: '遇到价值冲突时，AI 会以此为立场，不做骑墙表述',
    allowCustom: true,
    options: [
      { value: '真实胜过完美', label: '真实胜过完美', description: '宁可粗糙，不要精致的假' },
      { value: '有用胜过好看', label: '有用胜过好看', description: '能解决问题比文采重要' },
      { value: '独立判断胜过共识', label: '独立判断胜过共识', description: '不人云亦云，敢说反面' },
      { value: '长期胜过短期', label: '长期胜过短期', description: '宁要慢的复利，不要快的流量' },
    ],
  },
  {
    id: 'longterm_main',
    dimension: 'long_term_goal',
    category: '长期目标',
    question: '一年后，你希望这些创作给你带来什么？',
    hint: '这决定内容的时间取向：追单篇爆款，还是沉淀长期资产',
    allowCustom: true,
    options: [
      { value: '个人影响力', label: '个人影响力', description: '被特定人群记住和信任' },
      { value: '稳定收入', label: '稳定收入', description: '内容本身带来持续收益' },
      { value: '知识体系', label: '知识体系', description: '把自己的认知整理成体系' },
      { value: '同行认可', label: '同行认可', description: '在专业圈层建立声誉' },
    ],
  },

  // ── 类别 1：创作目的（1 问）──
  {
    id: 'goal_main',
    dimension: 'creator_goal',
    category: '创作目的',
    question: '你创作内容最希望达到什么？',
    hint: '这决定了 AI 生成内容时的目标导向',
    allowCustom: true,
    options: [
      {
        value: '获得流量',
        label: '获得流量',
        description: '追求传播广度，让更多人看到',
      },
      {
        value: '表达观点',
        label: '表达观点',
        description: '传递独特见解，引发讨论',
      },
      {
        value: '帮助别人解决问题',
        label: '帮助别人解决问题',
        description: '实用导向，提供可执行方案',
      },
      {
        value: '建立个人品牌',
        label: '建立个人品牌',
        description: '长期沉淀个人IP，形成影响力',
      },
    ],
  },

  // ── 类别 2：表达方式（1 问）──
  {
    id: 'expression_main',
    dimension: 'expression_profile',
    category: '表达方式',
    question: '你更希望你的内容：',
    hint: '这影响文章结构和节奏',
    allowCustom: true,
    options: [
      {
        value: '快速吸引注意',
        label: '快速吸引注意',
        description: '开头即抓住眼球，节奏紧凑',
      },
      {
        value: '慢慢铺垫产生沉浸感',
        label: '慢慢铺垫产生沉浸感',
        description: '层层递进，让读者代入',
      },
      {
        value: '深入分析背后逻辑',
        label: '深入分析背后逻辑',
        description: '抽丝剥茧，揭示底层规律',
      },
      {
        value: '制造情绪冲击',
        label: '制造情绪冲击',
        description: '用冲突和反差引发情绪',
      },
    ],
  },

  // ── 类别 3：思考方式（1 问）──
  {
    id: 'thinking_main',
    dimension: 'thinking_profile',
    category: '思考方式',
    question: '你更习惯怎么展开一个观点？',
    hint: '这影响论证逻辑和素材选择',
    allowCustom: true,
    options: [
      {
        value: '数据驱动',
        label: '数据驱动',
        description: '用数据和事实说话',
      },
      {
        value: '故事化',
        label: '故事化',
        description: '用故事和案例承载观点',
      },
      {
        value: '对比分析',
        label: '对比分析',
        description: '通过对比突出差异',
      },
      {
        value: '案例支撑',
        label: '案例支撑',
        description: '每个观点配具体案例',
      },
    ],
  },

  // ── 类别 4：叙事偏好（1 问）──
  {
    id: 'narrative_main',
    dimension: 'narrative_preference',
    category: '叙事偏好',
    question: '你更喜欢哪种叙事方式？',
    hint: '这影响叙事视角和推进方式',
    allowCustom: true,
    options: [
      {
        value: '故事化',
        label: '故事化',
        description: '用情节推进，有人物和场景',
      },
      {
        value: '分析式',
        label: '分析式',
        description: '逻辑推演，层层论证',
      },
      {
        value: '对话式',
        label: '对话式',
        description: '像在跟读者聊天',
      },
      {
        value: '散文式',
        label: '散文式',
        description: '形散神不散，情绪流淌',
      },
    ],
  },

  // ── 类别 5：情绪倾向（1 问）──
  {
    id: 'emotion_main',
    dimension: 'emotional_preference',
    category: '情绪倾向',
    question: '你希望你的内容给读者什么感受？',
    hint: '这影响情绪基调和氛围',
    allowCustom: true,
    options: [
      {
        value: '紧张',
        label: '紧张',
        description: '悬念冲突，让人想看下去',
      },
      {
        value: '温情',
        label: '温情',
        description: '温暖治愈，引发共鸣',
      },
      {
        value: '冷峻',
        label: '冷峻',
        description: '克制理性，冷静观察',
      },
      {
        value: '热血',
        label: '热血',
        description: '激情澎湃，激励行动',
      },
    ],
  },

  // ── 类别 6：好作品标准（1 问）──
  {
    id: 'quality_main',
    dimension: 'quality_standard',
    category: '好作品标准',
    question: '你认为好的作品应该让人：',
    hint: '这是你判断作品好坏的内在标准',
    allowCustom: true,
    options: [
      {
        value: '让人产生情绪',
        label: '让人产生情绪',
        description: '感动、震撼、共鸣',
      },
      {
        value: '让人获得知识',
        label: '让人获得知识',
        description: '学到新东西，认知升级',
      },
      {
        value: '让人改变想法',
        label: '让人改变想法',
        description: '打破旧认知，建立新视角',
      },
      {
        value: '帮助别人行动',
        label: '帮助别人行动',
        description: '不只是看，还能做',
      },
    ],
  },

  // ── 类别 7：排斥因素（1 问，硬约束）──
  {
    id: 'avoid_main',
    dimension: 'avoid_preference',
    category: '排斥因素',
    question: '你最不喜欢哪种内容？',
    hint: '这些会成为 AI 生成时的硬禁忌',
    allowCustom: true,
    options: [
      {
        value: '空洞鸡汤',
        label: '空洞鸡汤',
        description: '看似有道理，实则无内容',
      },
      {
        value: '流水账',
        label: '流水账',
        description: '平铺直叙，没有起伏',
      },
      {
        value: '夸张标题',
        label: '夸张标题',
        description: '标题党，内容与标题不符',
      },
      {
        value: '没有依据的观点',
        label: '没有依据的观点',
        description: '主观断言，缺乏支撑',
      },
    ],
  },

  // ── 类别 8：创作场景（1 问）──
  {
    id: 'scenario_main',
    dimension: 'creation_scenario',
    category: '创作场景',
    question: '你主要在哪里创作？',
    hint: '这影响输出形式和平台适配',
    allowCustom: true,
    options: [
      {
        value: '短视频',
        label: '短视频',
        description: '抖音/小红书/视频号',
      },
      {
        value: '文章',
        label: '文章',
        description: '公众号/知乎/博客',
      },
      {
        value: '商业方案',
        label: '商业方案',
        description: 'BP/报告/企划',
      },
      {
        value: '知识分享',
        label: '知识分享',
        description: '课程/教程/科普',
      },
    ],
  },

  // ── 类别 2b：表达方式补充（审美偏好第 2 问）──
  {
    id: 'expression_style',
    dimension: 'expression_profile',
    category: '审美偏好',
    question: '你喜欢的语言风格是？',
    hint: '这影响用词和语言质感',
    allowCustom: true,
    options: [
      {
        value: '简洁直接',
        label: '简洁直接',
        description: '少废话，直击要点',
      },
      {
        value: '专业严谨',
        label: '专业严谨',
        description: '术语精准，逻辑严密',
      },
      {
        value: '故事化表达',
        label: '故事化表达',
        description: '用故事承载观点',
      },
      {
        value: '哲学思考',
        label: '哲学思考',
        description: '抽象思辨，深度追问',
      },
    ],
  },

  // ── 类别 6b：好作品标准补充（价值倾向第 2 问）──
  {
    id: 'quality_depth',
    dimension: 'quality_standard',
    category: '价值倾向',
    question: '你更看重内容的哪个层面？',
    hint: '这影响内容深度取向',
    allowCustom: true,
    options: [
      {
        value: '高信息密度',
        label: '高信息密度',
        description: '单位字数传递更多有效信息',
      },
      {
        value: '强逻辑链条',
        label: '强逻辑链条',
        description: '论证严密，环环相扣',
      },
      {
        value: '强情绪张力',
        label: '强情绪张力',
        description: '情绪起伏大，代入感强',
      },
      {
        value: '强行动指引',
        label: '强行动指引',
        description: '给出明确可执行的下一步',
      },
    ],
  },
]

// ── 问题集元数据 ───────────────────────────────────────────

/** 当前问题集版本（未来调整问题时 +1，触发已访谈用户重新访谈） */
export const CURRENT_INTERVIEW_VERSION = 1

/** 6 类问题分类标签（UI 分组展示用） */
export const INTERVIEW_CATEGORIES = [
  '经历背景',
  '价值判断',
  '长期目标',
  '创作目的',
  '表达方式',
  '审美偏好',
  '思考方式',
  '叙事偏好',
  '情绪倾向',
  '好作品标准',
  '价值倾向',
  '排斥因素',
  '创作场景',
] as const

// ── 纯函数：按维度聚合回答 ─────────────────────────────────

/**
 * 把访谈回答列表聚合为 CreatorDeclaration 格式。
 * 同一维度多个问题回答时，后者覆盖前者（最后一次回答为准）。
 */
export function aggregateAnswers(
  answers: Array<{ dimension: DeclarationDimension; value: string }>
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const a of answers) {
    const val = typeof a.value === 'string' ? a.value.trim().slice(0, 200) : ''
    if (val) {
      result[a.dimension] = val
    }
  }
  return result
}
