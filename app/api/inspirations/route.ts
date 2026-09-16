import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

/** 单条推荐选题的结构 */
interface Inspiration {
  title: string
  description: string
  reason: string
  params: {
    category: string
    topic: string
  }
}

/**
 * 从 Authorization 头提取 Bearer token，验证用户身份。
 */
async function authenticate(req: Request) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) return null

  const supabase = createServerClient(token)
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token)
  if (error || !user) return null

  return { supabase, userId: user.id }
}

/**
 * 每个分类的选题模板池：随机选取 2 条作为模板推荐。
 * 模板只包含标题和描述，推荐理由由调用方拼接。
 */
const CATEGORY_TEMPLATES: Record<string, { title: string; description: string }[]> = {
  电影解说: [
    { title: '近期口碑爆棚的电影，3 分钟看懂', description: '挑选一部近期讨论度高的电影，拆解它的核心冲突和高光反转' },
    { title: '冷门佳作推荐：被低估的好片', description: '挖掘一部被票房埋没的好电影，分析它为什么值得看' },
    { title: '经典老片重温：为什么它至今不过时', description: '选一部影史经典，从当代视角重新解读它的魅力' },
    { title: '悬疑片拆解：反转是怎么设计的', description: '分析一部悬疑片的叙事结构，揭秘导演如何误导观众' },
  ],
  短剧解说: [
    { title: '爆款短剧为什么让人停不下来', description: '拆解一部热门短剧的节奏设计和情绪钩子' },
    { title: '短剧里的反转套路，你学废了吗', description: '总结短剧常用反转手法，用一集做案例拆解' },
    { title: '从零理解短剧：小白也能写的入门指南', description: '用通俗语言讲解短剧创作的基本要素' },
  ],
  纪录片解说: [
    { title: '你不知道的地球角落', description: '介绍一个鲜为人知的地理奇观或文化现象' },
    { title: '历史的另一面：被忽略的真相', description: '选一段历史事件，挖掘教科书没讲的细节' },
    { title: '自然界的生存智慧', description: '讲解一种动物的独特生存策略，类比人类生活' },
  ],
  动漫解说: [
    { title: '这部动漫为什么封神', description: '选一部高分动漫，拆解它叙事和作画的高光时刻' },
    { title: '热血番的燃点是怎么设计的', description: '分析一部热血动漫的节奏，讲解燃感从何而来' },
    { title: '冷门宝藏动漫推荐', description: '推荐一部被埋没的好番，说说它为什么被低估' },
  ],
  故事文案: [
    { title: '一个关于选择的故事', description: '围绕人生岔路口写一段叙事，引发共鸣' },
    { title: '深夜食堂式的温情短故事', description: '用日常场景写一段治愈系故事' },
    { title: '反转结局：读者没想到的真相', description: '设计一个带反转结局的短篇，制造惊喜' },
  ],
  读书解读: [
    { title: '经典书目：这本书为什么值得一读', description: '选一本经典书籍，提炼核心观点和阅读价值' },
    { title: '工具书拆解：3 个方法立刻能用', description: '从一本实用类书籍中提取 3 个可操作的方法' },
    { title: '畅销书速读：10 分钟看懂核心', description: '压缩解读一本热门书的核心论点' },
  ],
  剧本打磨: [
    { title: '把一段对话改到「能演」', description: '选一段平淡对话，通过台词和动作改造让它有戏' },
    { title: '冲突升级练习：从平淡到激烈', description: '设计一个逐步升级冲突的场景，练习节奏控制' },
    { title: '角色弧光设计：让人物活起来', description: '为一个扁平角色设计成长弧线，写出关键转折' },
  ],
}

/**
 * 从模板池中随机选取 n 条不重复的选题。
 * 如果池子不够 n 条，返回全部。
 */
function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr]
  const result: T[] = []
  while (copy.length > 0 && result.length < n) {
    const idx = Math.floor(Math.random() * copy.length)
    result.push(copy.splice(idx, 1)[0])
  }
  return result
}

/** 平台推荐条目：跨全分类池的模板 + 其真实分类（新用户冷启动/兜底补齐共用） */
type PlatformPick = { title: string; description: string; category: string }

/**
 * 跨全分类池随机抽取，按标题去重并排除已选条目。
 * 关键：冷启动用户没有偏好分类，平台推荐必须跨分类，不能全部落在 CATEGORIES[0]。
 */
function pickPlatformPicks(n: number, excludeTitles: Set<string>): PlatformPick[] {
  const all: PlatformPick[] = Object.entries(CATEGORY_TEMPLATES).flatMap(([category, items]) =>
    items.map((it) => ({ ...it, category }))
  )
  return pickRandom(all, all.length)
    .filter((it) => !excludeTitles.has(it.title))
    .slice(0, n)
}

export async function GET(req: Request) {
  try {
    const auth = await authenticate(req)
    if (!auth) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const { supabase, userId } = auth

    const inspirations: Inspiration[] = []
    // 已用标题：跨素材/偏好模板/平台补齐统一去重，杜绝同卡重复
    const usedTitles = new Set<string>()

    // ── 1) 统计用户最常用的 category（generation_history 按出现次数排序）──
    const { data: topCategories, error: catErr } = await supabase
      .from('generation_history')
      .select('category')
      .eq('user_id', userId)
      .not('category', 'is', null)

    if (catErr) {
      console.error('查询分类统计失败:', catErr)
    }

    // 口径：分类出现次数 = 该用户 generation_history 中该 category 的行数
    const categoryCounts = new Map<string, number>()
    for (const row of topCategories ?? []) {
      const cat = row.category
      if (cat && cat.trim()) {
        categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1)
      }
    }

    // 冷启动判定：没有任何作品分类记录 = 新用户。
    // 此时绝不回退默认分类伪装个性化（否则会出现"你常创作电影解说"的虚假理由）。
    const sortedCategories = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])
    const hasHistory = sortedCategories.length > 0

    // ── 冷启动路径：直接给 3 条跨分类平台推荐，理由如实标注 ──
    if (!hasHistory) {
      for (const pick of pickPlatformPicks(3, usedTitles)) {
        usedTitles.add(pick.title)
        inspirations.push({
          title: pick.title,
          description: pick.description,
          // 无真实热度数据前不自称"热门"，诚实标注为平台推荐
          reason: '平台推荐选题',
          params: { category: pick.category, topic: pick.title },
        })
      }
      return NextResponse.json({ inspirations })
    }

    // ── 个性化路径（有作品的用户） ──
    const topCategory = sortedCategories[0][0]

    // ── 2) 基于用户保存的素材推荐（该分类下随机 1 条）──
    const { data: scripts, error: scriptErr } = await supabase
      .from('scripts')
      .select('content, category, created_at')
      .eq('user_id', userId)
      .eq('category', topCategory)
      .order('created_at', { ascending: false })
      .limit(50)

    if (scriptErr) {
      console.error('查询素材失败:', scriptErr)
    }

    if (scripts && scripts.length > 0) {
      // 随机选 1 条：从最近 50 条中取，兼顾新鲜度和随机性
      const randomScript = scripts[Math.floor(Math.random() * scripts.length)]
      const content = (randomScript.content ?? '').trim()
      if (content) {
        // 标题取内容前 20 字（截断到第一个句号/换行），避免标题过长
        let title = content.slice(0, 20)
        const cutIdx = Math.min(
          ...['。', '！', '？', '\n', '，']
            .map((sep) => {
              const i = title.indexOf(sep)
              return i === -1 ? 20 : i
            })
        )
        title = title.slice(0, cutIdx || 20) || title

        if (!usedTitles.has(title)) {
          usedTitles.add(title)
          inspirations.push({
            title,
            description: content.slice(0, 60) + (content.length > 60 ? '…' : ''),
            reason: `基于你保存的「${topCategory}」风格素材`,
            params: {
              category: topCategory,
              topic: title,
            },
          })
        }
      }
    }

    // ── 3) 从偏好分类模板池中取 2 条（自定义等无模板分类时回退跨分类平台池）──
    const preferredTemplates = CATEGORY_TEMPLATES[topCategory]
    if (preferredTemplates) {
      for (const tpl of pickRandom(preferredTemplates, preferredTemplates.length)) {
        if (inspirations.length >= 3) break
        if (usedTitles.has(tpl.title)) continue
        usedTitles.add(tpl.title)
        inspirations.push({
          title: tpl.title,
          description: tpl.description,
          reason: `因为你常创作「${topCategory}」类型的内容`,
          params: {
            category: topCategory,
            topic: tpl.title,
          },
        })
      }
    }

    // ── 兜底：不足 3 条时跨全分类补齐，排除已选（修复同池抽取导致的重复卡）──
    if (inspirations.length < 3) {
      for (const pick of pickPlatformPicks(3 - inspirations.length, usedTitles)) {
        usedTitles.add(pick.title)
        inspirations.push({
          title: pick.title,
          description: pick.description,
          reason: '平台推荐选题',
          params: {
            category: pick.category,
            topic: pick.title,
          },
        })
      }
    }

    return NextResponse.json({ inspirations: inspirations.slice(0, 3) })
  } catch (error) {
    console.error('inspirations API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
