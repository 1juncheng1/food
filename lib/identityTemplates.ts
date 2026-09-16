// 5 套官方身份模板，前端展示与后端 prompt 构建共用
import { userScopedKey } from './storageOwner'

export interface IdentityTemplate {
  id: string
  name: string
  description: string
  identity: string
}

export const IDENTITY_TEMPLATES: IdentityTemplate[] = [
  {
    id: 'critic',
    name: '深度影评人',
    description: '擅长拆解剧情隐喻、镜头语言，理性犀利',
    identity:
      '你是一位深度影评人，擅长拆解剧情隐喻和镜头语言，风格理性犀利，能从专业角度剖析作品深层含义。',
  },
  {
    id: 'popularizer',
    name: '知识科普博主',
    description: '通俗大白话，避开晦涩术语，适合短视频',
    identity:
      '你是一位知识科普博主，擅长用通俗大白话讲解复杂概念，避开晦涩术语，节奏轻快，适合短视频传播。',
  },
  {
    id: 'analyst',
    name: '资深行业分析师',
    description: '逻辑严谨，多角度利弊分析，客观冷静',
    identity:
      '你是一位资深行业分析师，逻辑严谨，善于从多角度进行利弊分析，态度客观冷静，结论有据可依。',
  },
  {
    id: 'storyteller',
    name: '故事型解说',
    description: '氛围感强，悬念开场，叙事感浓厚',
    identity:
      '你是一位故事型解说创作者，擅长营造氛围感，以悬念开场，叙事感浓厚，让听众沉浸其中。',
  },
  {
    id: 'roaster',
    name: '犀利吐槽向解说',
    description: '语言幽默，观点鲜明，自带网感',
    identity:
      '你是一位犀利吐槽向解说创作者，语言幽默犀利，观点鲜明直接，自带互联网网感，金句频出。',
  },
]

// ── 用户自定义身份（localStorage 持久化，纯前端方案，不改数据库） ──
// 第九阶段安全修复：按登录用户分桶，切换账号不互见自定义身份

export interface CustomIdentity {
  id: string
  name: string // 身份名称，如：美食探店博主
  type: string // 内容领域/类型，如：美食测评
  style: string // 语言风格，如：轻松幽默、口语化
  extra: string // 补充说明（可选）
}

const CUSTOM_IDENTITIES_KEY = 'custom_identities'

export function getCustomIdentities(): CustomIdentity[] {
  try {
    const key = userScopedKey(CUSTOM_IDENTITIES_KEY)
    // 归属未就绪：返回空，绝不读取他人自定义身份
    if (!key) return []
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveCustomIdentity(identity: CustomIdentity): void {
  try {
    const key = userScopedKey(CUSTOM_IDENTITIES_KEY)
    if (!key) return
    const list = getCustomIdentities()
    list.unshift(identity)
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    // localStorage 不可用（隐私模式/空间已满）时静默失败
  }
}

export function deleteCustomIdentity(id: string): void {
  try {
    const key = userScopedKey(CUSTOM_IDENTITIES_KEY)
    if (!key) return
    localStorage.setItem(
      key,
      JSON.stringify(getCustomIdentities().filter((c) => c.id !== id))
    )
  } catch {
    // 同上
  }
}

/** 把自定义身份组合成与官方模板同格式的身份描述 */
export function identityToPrompt(c: CustomIdentity): string {
  const parts = [
    `你是一位${c.name}，专注于${c.type}领域的内容创作，语言风格：${c.style}`,
  ]
  if (c.extra.trim()) parts.push(c.extra.trim())
  return parts.join('。') + '。'
}
