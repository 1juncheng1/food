// 生成作品的本地持久化工具（纯前端方案，不改动数据库和后端接口）
// 注意：localStorage 按浏览器隔离，换设备/清缓存后作品不保留
// 第九阶段安全修复：同一浏览器内再按登录用户分桶，切换账号绝不互见作品

import { userScopedKey } from './storageOwner'

export interface GeneratedWork {
  id: string
  title: string
  content: string
  category: string
  created_at: string
  identityLabel?: string // 生成时的身份名称（/article 页展示与「再次生成同款风格」用）
  style?: string // 生成时的文风描述
  systemPrompt?: string // 生成的成品系统提示词（/article 页 A 区展示）
  blueprint?: import('@/lib/creative/blueprint').CreativeBlueprint // 创作进化系统：本次生成依据的蓝图
  // 创作进化系统阶段 3：多版本归属（仅登录用户的项目作品有值，老作品/游客作品为 undefined）
  projectId?: string // creative_projects.id
  versionId?: string // 该版本在 generation_history 的真实行 id（pid::vN）
  versionNumber?: number // 版本号 V1/V2/V3…
  // 阶段 4：AI 五维诊断报告（生成后异步获得；云端同源数据在 generation_history.analysis）
  analysis?: import('@/lib/creative/diagnosis').CreativeDiagnosis
  // 阶段 5：该版本若为定向迭代版，记录所选择的优化方向（hit/style/emotion/depth/video/script/custom）
  improveDirection?: import('@/lib/creative/diagnosis').NextActionKey
  // 第四阶段：AI 对该迭代版"改了什么"的一句话说明（V1 无此字段）
  improveNote?: string | null
  // 阶段 4 Work Agent：该版本基于哪条用户反馈生成（V1 为 null）
  // 与 improveNote 互补：userFeedback 是用户说的原话，improveNote 是 AI 说改了什么
  userFeedback?: string | null
  // 个人化引擎：本次生成实际参考了哪些用户数据（证据行展示用，不含 prompt 原文）
  personalization?: import('@/lib/creative/creatorModel').PersonalizationEvidence
  // 阶段 5：本次生效的创作者声明维度（供 article 页展示"本次参考了你的这些偏好"）
  declarationTraits?: Array<{ dimension: string; label: string; hard?: boolean }>
  // Creator Mode：本篇创作模式（老作品/未记录为 undefined，展示时按通用生成兜底）
  mode?: import('@/lib/creative/personalization').CreationMode
  // 阶段四：本次登场角色快照（文章页展示；improve 迭代时原样带入延续人设）
  characters?: import('@/lib/characters').CharacterSnapshot[]
  // 2a：非内容类问题的结构化解决方案（/solution 页展示用；content 存全文 Markdown）
  solution?: import('@/lib/creative/problemSolver').SolutionResult
  // 解决方案迭代：全部版本（旧→新，末位=当前版）；老数据/单版本作品为 undefined
  solutionVersions?: import('@/lib/creative/problemSolver').SolutionVersion[]
  // 原始用户问题（解决方案作品存储，供补强迭代与恢复后重试用；正文作品留空）
  topic?: string
}

const WORKS_KEY = 'generated_works'

/** 当前用户私有存储键；归属未就绪（鉴权中/未登录）时为 null */
function worksKey(): string | null {
  return userScopedKey(WORKS_KEY)
}

/** 生成稳定唯一 id（localStorage 场景无需数据库 uuid） */
export function makeWorkId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function getWorks(): GeneratedWork[] {
  try {
    const key = worksKey()
    // 归属未就绪：返回空，绝不读取全局/他人桶（防越权展示）
    if (!key) return []
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    // 去重：历史版本 saveWork 曾用 unshift 产生同 id 重复数据，读取时顺带修复
    const seen = new Set<string>()
    return parsed.filter((w) => {
      if (!w?.id || seen.has(w.id)) return false
      seen.add(w.id)
      return true
    })
  } catch {
    return []
  }
}

/** 按 id 查单篇作品（/article/[id] 页使用）；天然限定在当前用户桶内 */
export function getWork(id: string): GeneratedWork | null {
  return getWorks().find((w) => w.id === id) ?? null
}

export function saveWork(work: GeneratedWork): void {
  try {
    const key = worksKey()
    // 无归属不写入：防止在鉴权竞态下把作品落进错误/全局桶
    if (!key) return
    const works = getWorks()
    const idx = works.findIndex((w) => w.id === work.id)
    if (idx >= 0) {
      // 覆盖已有记录（编辑/重新生成场景）
      works[idx] = work
    } else {
      works.unshift(work) // 新作品插入最前
    }
    localStorage.setItem(key, JSON.stringify(works))
  } catch {
    // localStorage 不可用（隐私模式/空间已满）时静默失败，不影响生成主流程
  }
}

export function deleteWork(id: string): void {
  try {
    const key = worksKey()
    if (!key) return
    localStorage.setItem(
      key,
      JSON.stringify(getWorks().filter((w) => w.id !== id))
    )
  } catch {
    // 同上
  }
}

/** 局部更新一篇作品（阶段 4 用于回填 analysis 诊断，避免整对象覆盖丢字段） */
export function patchWork(id: string, patch: Partial<GeneratedWork>): void {
  try {
    const key = worksKey()
    if (!key) return
    const works = getWorks()
    const idx = works.findIndex((w) => w.id === id)
    if (idx < 0) return
    works[idx] = { ...works[idx], ...patch }
    localStorage.setItem(key, JSON.stringify(works))
  } catch {
    // 同 saveWork：静默失败
  }
}
