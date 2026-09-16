// ============================================================
// Creator Mode —— 创作模式裁决与个性化装配（蓝图/正文唯一共用口径）
//
// 两种模式的本质区别：
//   inspiration（灵感模式 / System AI）：隐性个人画像一律不参与创作，
//     只用平台通用能力 + 用户本次显式输入（主题/身份/文风/角色）；
//   creator（我的模式 / Creator AI）：启用全部个人数据装配
//     （历史记忆/风格卡/创作者人格/素材库检索/五维画像）。
//
// 设计原则：
// 1. 本模块为纯函数，不读库不调 LLM，蓝图 API 与正文 API 必须共用，
//    禁止两处各自裁决（否则会出现"蓝图个性化、正文通用化"的精分）；
// 2. 登场角色属于用户本次显式选择的"内容资产"，不在剥离范围；
// 3. 旧客户端只传 useCreatorModel 布尔值时自动映射，保证灰度不中断；
// 4. 游客请求 creator 一律降级为 inspiration（无个人数据可注入）。
// ============================================================

export type CreationMode = 'inspiration' | 'creator'

export const CREATION_MODES: CreationMode[] = ['inspiration', 'creator']

// ============================================================
// 任务隔离模式（解决"我的模式"历史作品污染当前主题的问题）
//   new          新独立创作任务（默认）：禁止继承历史作品中的具体角色名、
//                剧情桥段、世界观设定；只允许借鉴抽象的语言节奏、叙事方式、
//                创作者人格。对应"昨天僵尸先生 → 今天商业计划书"的场景。
//   continuation 继续创作：当 body.projectId 或 body.improve 存在时进入，
//                允许继承该项目下的角色、剧情、世界观设定。
// ============================================================
export type TaskMode = 'new' | 'continuation'

export const CREATION_MODE_META: Record<
  CreationMode,
  { label: string; aiName: string; tagline: string; audience: string }
> = {
  inspiration: {
    label: '灵感模式',
    aiName: 'System AI',
    tagline: 'AI根据平台优秀创作经验帮助你发现新的表达方式',
    audience: '适合新用户',
  },
  creator: {
    label: '我的模式',
    aiName: 'Creator AI',
    tagline: 'AI根据你的创作者人格和历史作品进行创作',
    audience: '适合已有创作记录',
  },
}

export function isCreationMode(v: unknown): v is CreationMode {
  return typeof v === 'string' && (CREATION_MODES as string[]).includes(v)
}

/**
 * 模式裁决。
 * @param rawMode            新版请求体里的 mode
 * @param isAuthed           是否已登录（游客强制 inspiration）
 * @param legacyUseCreator   旧版请求体里的 useCreatorModel（mode 缺省时兼容映射）
 */
export function resolveMode(
  rawMode: unknown,
  isAuthed: boolean,
  legacyUseCreator?: unknown
): CreationMode {
  // 新版 mode 优先；游客显式选 creator 也降级（后端不信任前端登录态声明）
  if (isCreationMode(rawMode)) {
    return rawMode === 'creator' && !isAuthed ? 'inspiration' : rawMode
  }
  // 旧客户端兼容：显式 false → 灵感；其余（true/缺省）登录用户走我的模式
  if (legacyUseCreator === false) return 'inspiration'
  return isAuthed ? 'creator' : 'inspiration'
}

/** 本次生成各个人数据注入块的去留计划（装配层的唯一输出） */
export interface PersonalizationPlan {
  mode: CreationMode
  /** 任务隔离模式：new=新独立任务（默认）/ continuation=继续上一项目 */
  taskMode: TaskMode
  /** localStorage 历史记忆（高频身份/文风/品类/收藏范文摘录） */
  useLocalMemory: boolean
  /** style_profiles 风格统计特征 + 五维行为画像 */
  useStyleProfile: boolean
  /** style_profiles.creator_report / 9.5 创作者人格块 */
  useCreatorPersonality: boolean
  /** scripts 素材库的主题向量检索 */
  useMaterialSearch: boolean
}

/**
 * 由模式推导注入计划。
 * 灵感模式四块全关；我的模式四块全开（各块内部仍按"有无数据"自行空值降级）。
 * taskMode 默认 'new'；继续创作由调用方在 projectId / improve 信号命中时传入。
 */
export function planPersonalization(
  mode: CreationMode,
  taskMode: TaskMode = 'new'
): PersonalizationPlan {
  if (mode === 'creator') {
    return {
      mode,
      taskMode,
      useLocalMemory: true,
      useStyleProfile: true,
      useCreatorPersonality: true,
      useMaterialSearch: true,
    }
  }
  return {
    mode,
    taskMode,
    useLocalMemory: false,
    useStyleProfile: false,
    useCreatorPersonality: false,
    useMaterialSearch: false,
  }
}

/**
 * 我的模式：专属 AI 身份声明（蓝图构思/提示词工程/正文撰写三处共用同一口径）。
 * 关键不只是"给数据"，而是让模型在身份层确认：我是长期理解这个创作者的伙伴，
 * 产出要像"他本人会写的"，而非"该主题的通用范文"。
 * 灵感模式返回 null（零污染）；禁止编造样本数量，citedWorks 为真实检索命中数。
 *
 * 任务隔离边界（taskMode）：
 *   new          新独立创作任务：禁止把历史作品中的具体角色名、剧情桥段、世界观
 *                设定带入本次创作；只允许借鉴抽象的语言节奏、叙事方式、创作者人格。
 *                → 解决"昨天僵尸先生 → 今天商业计划书"的跨主题污染问题。
 *   continuation 继续创作：允许继承该项目下的角色、剧情、世界观设定。
 */
export interface CreatorIdentityBlocks {
  /** 给"提示词工程师"LLM：要求其产出的系统提示词自带长期专属伙伴身份 */
  forPromptBuilder: string
  /** 给正文撰写 LLM 的身份锚定（置于本次要求之前） */
  forWriter: string
}

export function buildCreatorIdentity(
  mode: CreationMode,
  taskMode: TaskMode = 'new',
  citedWorks = 0
): CreatorIdentityBlocks | null {
  if (mode !== 'creator') return null

  const evidenceLine = citedWorks > 0 ? `你还能看到该创作者 ${citedWorks} 篇与本次主题高度相近的真实旧作。` : ''

  const core =
    '你不是通用写作助手，而是这位创作者的【长期专属创作伙伴 Creator AI】：' +
    '你已经基于 ta 的历史作品、创作 DNA、素材积累与反馈持续学习，理解 ta 的人格定位、母题偏好、叙事习惯、语言节奏与创作边界。' +
    evidenceLine

  // 任务隔离边界：new 模式硬性禁止继承历史具体内容；continuation 模式允许继承项目设定
  const boundaryLine =
    taskMode === 'continuation'
      ? '【任务模式：继续创作（Continuation Mode）】本次属于同一创作项目的迭代/续写，允许继承该项目下既有的角色、剧情、世界观设定；与本次主题无关的旧作仍不要参考。'
      : '【任务隔离边界（本次为新独立创作任务，必须严格遵守）】禁止把历史作品中的具体角色名、剧情桥段、世界观设定带入本次创作；只允许借鉴历史中抽象的语言节奏、叙事方式、创作者人格；与本次主题无关的旧作不要参考。'

  return {
    forPromptBuilder: `${core}
${boundaryLine}
本次你要生成的系统提示词，必须让接手的写作模型明确：
1. 写作目标是"像这位创作者本人会写出来的样子"，不是产出该主题的通用范文；
2. 在【角色定位】板块直接写入"你是该创作者长期专属的创作伙伴，深谙其创作人格与历史风格"；
3. 把该创作者的人格、叙事与语言特征固化进【语言风格】板块；
4. 该创作者明确排斥的元素写入【禁止事项】。
注意：创作者本次的显式要求（主题/身份/字数/蓝图）始终最高优先级，个人风格服务于本次表达而非压过它。`,
    forWriter: `${core}
${boundaryLine}
所以本次创作请自然代入 ta 的视角与笔触：选题切入、叙事推进、开头方式、语言节奏都要贴合这位创作者，而不是套用平台通用模板。
边界：本次主题与创作要求是最高优先级；只参考下方真实给出的创作者资料，禁止臆造 ta 的职业、经历等个人事实；明确排斥的元素一律不得出现。`,
  }
}
