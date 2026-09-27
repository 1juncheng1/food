import { HOME_IMAGES } from './vision-assets'

// ────────────────────────────────────────────────────────────
// 首页 Landing Page 静态内容
//
// 纯文案常量，不依赖数据库与接口。首页对未登录用户开放，
// 因此社区预览等内容全部走内置示例数据，避免首屏请求与 401。
// ────────────────────────────────────────────────────────────

/** 创作者成长路径：三列卡片 */
export interface GrowthPathItem {
  id: string
  /** 卡片标题 */
  title: string
  /** 对应的系统能力 */
  system: string
  /** 卡片描述 */
  desc: string
  /** 图片路径，统一来自 /images/vision/ 注册表 */
  image: string
  /**
   * 素材原始像素尺寸。三张封面比例各不相同，按原尺寸渲染才能做到「不裁切」；
   * 换图时这里必须跟着改，否则裁切会以「毫无报错」的方式回来。
   */
  width: number
  height: number
}

export const GROWTH_PATH: GrowthPathItem[] = [
  {
    id: 'inspiration',
    title: '收集你的灵感',
    system: 'Personal Knowledge Base',
    desc: '将文章、视频、想法和知识沉淀下来，让AI逐渐理解你的创作世界。',
    image: HOME_IMAGES.path[0],
    width: 736,
    height: 920,
  },
  {
    id: 'knowledge',
    title: '形成你的观点',
    system: 'Creator Knowledge System',
    desc: 'AI结合你的知识、经历和思考方式，帮助你从信息中形成独特视角。',
    image: HOME_IMAGES.path[1],
    width: 736,
    height: 920,
  },
  {
    id: 'creation',
    title: '创作你的作品',
    system: 'AI生成 + Work Agent',
    desc: '从一个模糊想法开始，与AI共同完善结构、观点和表达。',
    image: HOME_IMAGES.path[2],
    width: 725,
    height: 1080,
  },
]

/** 核心能力：不再展示模板类型，只讲能力 */
export interface CapabilityItem {
  id: string
  icon: 'compass' | 'profile' | 'library' | 'cocreate' | 'community'
  title: string
  desc: string
}

export const CAPABILITIES: CapabilityItem[] = [
  {
    id: 'inspire',
    icon: 'compass',
    title: '灵感推荐',
    desc: 'AI结合你的兴趣、知识和创作习惯，发现真正适合你的内容方向。',
  },
  {
    id: 'profile',
    icon: 'profile',
    title: '创作者画像',
    desc: '记录你的创作习惯，让作品越来越接近你的风格。',
  },
  {
    id: 'library',
    icon: 'library',
    title: '个人知识库',
    desc: '保存你的观点、案例和知识，让AI调用属于你的内容基础。',
  },
  {
    id: 'cocreate',
    icon: 'cocreate',
    title: 'AI共创',
    desc: '理解你的反馈，针对问题持续优化，而不是简单重新生成。',
  },
  {
    id: 'community',
    icon: 'community',
    title: '灵感社区',
    desc: '分享作品，交流观点，发现不同创作者的思考方式。',
  },
]

/** AI 创作流程：6 步 */
export interface WorkflowStep {
  id: string
  title: string
  note: string
}

export const WORKFLOW_STEPS: WorkflowStep[] = [
  { id: 'idea', title: '一个想法', note: '模糊的念头也足以开始' },
  { id: 'understand', title: 'AI理解问题', note: '厘清你真正想表达什么' },
  { id: 'strategy', title: '形成创作策略', note: '结构、角度与证据' },
  { id: 'draft', title: '生成作品', note: '用你的表达方式落笔' },
  { id: 'refine', title: '持续优化', note: '理解反馈，定点修改' },
  { id: 'asset', title: '成为你的创作资产', note: '沉淀进你的知识库' },
]

/** 灵感社区预览：内置示例（不请求接口） */
export interface CommunitySample {
  id: string
  title: string
  excerpt: string
  author: string
  tag: string
}

export const COMMUNITY_SAMPLES: CommunitySample[] = [
  {
    id: 's1',
    title: '为什么我们越来越难读完一本书',
    excerpt:
      '不是注意力变差了，而是信息环境改变了阅读的收益结构。我从三个层面拆开这件事，并给出可执行的调整方式。',
    author: '林一舟',
    tag: '观点',
  },
  {
    id: 's2',
    title: '小城咖啡馆的十二个月',
    excerpt:
      '一家开在县城街角的咖啡馆，记录下人来人往。写作时我保留了大量对话，让现场自己说话。',
    author: '沈迟',
    tag: '叙事',
  },
  {
    id: 's3',
    title: 'AI 会取代创作者吗',
    excerpt:
      '取代的不是创作者，而是没有观点的表达。真正稀缺的是判断力、审美与经历，这些恰恰可以被沉淀下来。',
    author: '周未',
    tag: '思考',
  },
]
