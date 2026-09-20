// ============================================================
// Creator Interest Profile —— 冷启动模板（从 /api/inspirations 搬迁）
//
// 画像为空或队列为空时的诚实降级路径。
// 模板内容原样保留，不做任何个性化伪装。
// ============================================================

import { dailySeed, mulberry32 } from './ranking'

export interface FallbackInspiration {
  title: string
  description: string
  category: string
}

export const FALLBACK_TEMPLATES: Record<string, FallbackInspiration[]> = {
  电影解说: [
    { title: '近期口碑爆棚的电影，3 分钟看懂', description: '挑选一部近期讨论度高的电影，拆解它的核心冲突和高光反转', category: '电影解说' },
    { title: '冷门佳作推荐：被低估的好片', description: '挖掘一部被票房埋没的好电影，分析它为什么值得看', category: '电影解说' },
    { title: '经典老片重温：为什么它至今不过时', description: '选一部影史经典，从当代视角重新解读它的魅力', category: '电影解说' },
    { title: '悬疑片拆解：反转是怎么设计的', description: '分析一部悬疑片的叙事结构，揭秘导演如何误导观众', category: '电影解说' },
  ],
  短剧解说: [
    { title: '爆款短剧为什么让人停不下来', description: '拆解一部热门短剧的节奏设计和情绪钩子', category: '短剧解说' },
    { title: '短剧里的反转套路，你学废了吗', description: '总结短剧常用反转手法，用一集做案例拆解', category: '短剧解说' },
    { title: '从零理解短剧：小白也能写的入门指南', description: '用通俗语言讲解短剧创作的基本要素', category: '短剧解说' },
  ],
  纪录片解说: [
    { title: '你不知道的地球角落', description: '介绍一个鲜为人知的地理奇观或文化现象', category: '纪录片解说' },
    { title: '历史的另一面：被忽略的真相', description: '选一段历史事件，挖掘教科书没讲的细节', category: '纪录片解说' },
    { title: '自然界的生存智慧', description: '讲解一种动物的独特生存策略，类比人类生活', category: '纪录片解说' },
  ],
  动漫解说: [
    { title: '这部动漫为什么封神', description: '选一部高分动漫，拆解它叙事和作画的高光时刻', category: '动漫解说' },
    { title: '热血番的燃点是怎么设计的', description: '分析一部热血动漫的节奏，讲解燃感从何而来', category: '动漫解说' },
    { title: '冷门宝藏动漫推荐', description: '推荐一部被埋没的好番，说说它为什么被低估', category: '动漫解说' },
  ],
  故事文案: [
    { title: '一个关于选择的故事', description: '围绕人生岔路口写一段叙事，引发共鸣', category: '故事文案' },
    { title: '深夜食堂式的温情短故事', description: '用日常场景写一段治愈系故事', category: '故事文案' },
    { title: '反转结局：读者没想到的真相', description: '设计一个带反转结局的短篇，制造惊喜', category: '故事文案' },
  ],
  读书解读: [
    { title: '经典书目：这本书为什么值得一读', description: '选一本经典书籍，提炼核心观点和阅读价值', category: '读书解读' },
    { title: '工具书拆解：3 个方法立刻能用', description: '从一本实用类书籍中提取 3 个可操作的方法', category: '读书解读' },
    { title: '畅销书速读：10 分钟看懂核心', description: '压缩解读一本热门书的核心论点', category: '读书解读' },
  ],
  剧本打磨: [
    { title: '把一段对话改到「能演」', description: '选一段平淡对话，通过台词和动作改造让它有戏', category: '剧本打磨' },
    { title: '冲突升级练习：从平淡到激烈', description: '设计一个逐步升级冲突的场景，练习节奏控制', category: '剧本打磨' },
    { title: '角色弧光设计：让人物活起来', description: '为一个扁平角色设计成长弧线，写出关键转折', category: '剧本打磨' },
  ],
}

const ALL_TEMPLATES = Object.values(FALLBACK_TEMPLATES).flat()

/**
 * 日种子确定性抽样（WF0，替代 Math.random）：
 * 与个性化路径的 stableOrder 共用同一套日种子约定——同日刷新恒定，跨日受控轮换。
 * seed 仅用于测试注入；生产调用走默认当日种子。
 */
export function getFallbackInspirations(n: number = 3, seed?: string): FallbackInspiration[] {
  const rng = mulberry32(seed ?? dailySeed())
  const copy = [...ALL_TEMPLATES]
  // Fisher-Yates 确定性洗牌，取前 n
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}
