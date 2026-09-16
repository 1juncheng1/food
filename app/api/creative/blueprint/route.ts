import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabaseServer'
import { IDENTITY_TEMPLATES } from '@/lib/identityTemplates'
import { generateBlueprint, type BlueprintInput } from '@/lib/creative/blueprint'
import { formatStyleDimensions } from '@/lib/creative/styleLearning'
import { formatCreatorModel } from '@/lib/creative/creatorModel'
import {
  resolveMode,
  planPersonalization,
  buildCreatorIdentity,
} from '@/lib/creative/personalization'
import { fetchCreatorStyleProfile } from '@/lib/creative/styleProfileRepo'
import {
  sanitizeCharacterInput,
  formatCharactersForPrompt,
} from '@/lib/characters'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

interface RequestBody {
  topic?: unknown
  templateId?: unknown
  customIdentity?: unknown
  identityLabel?: unknown
  style?: unknown
  wordCount?: unknown
  category?: unknown
  customCategory?: unknown
  memory?: unknown
  // 个人化引擎开关（旧客户端兼容；新客户端传 mode）
  useCreatorModel?: unknown
  // Creator Mode：灵感模式剥离风格卡/历史记忆，仅保留显式输入与角色
  mode?: unknown
  // 阶段四：登场角色快照数组（服务端清洗，最多 3 个）
  characters?: unknown
}

function str(v: unknown, maxLen: number): string {
  return typeof v === 'string' ? v.trim().slice(0, maxLen) : ''
}

/**
 * POST /api/creative/blueprint
 * 创作进化系统阶段 2：登录用户在生成正文前先获得"创作蓝图"。
 * 鉴权为强制（进化系统仅登录用户可用）；LLM 失败返回 502，
 * 前端的策略是静默降级为"无蓝图直接生成"，不让用户卡死。
 */
export async function POST(req: Request) {
  try {
    // ── 强制鉴权 ──
    const authHeader = req.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const supabase = createServerClient(token)
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token)
    if (authErr || !user) {
      return NextResponse.json({ error: '登录已过期' }, { status: 401 })
    }

    const body = (await req.json()) as RequestBody

    // ── 参数校验（与 prompt-optimizer 同口径） ──
    const topic = str(body.topic, 500)
    if (!topic) {
      return NextResponse.json({ error: '请填写解说主题' }, { status: 400 })
    }
    const wordCountNum = Number(body.wordCount)
    const wordCount =
      Number.isFinite(wordCountNum) && wordCountNum > 0
        ? Math.min(Math.floor(wordCountNum), 5000)
        : 0
    if (!wordCount) {
      return NextResponse.json({ error: '请填写有效的字数' }, { status: 400 })
    }

    const customIdentity = str(body.customIdentity, 2000)
    const template = IDENTITY_TEMPLATES.find((t) => t.id === body.templateId)
    const identity = customIdentity || template?.identity || ''
    const identityLabel =
      str(body.identityLabel, 200) || customIdentity || template?.name || '通用解说者'
    if (!identity) {
      return NextResponse.json({ error: '请选择创作者身份' }, { status: 400 })
    }

    const category = str(body.category, 30)
    const customCategory = str(body.customCategory, 50)
    const resolvedCategory = customCategory || category || '未指定'
    const style = str(body.style, 500)

    const mem =
      typeof body.memory === 'object' && body.memory !== null
        ? (body.memory as Record<string, unknown>)
        : {}

    // ── Creator Mode 裁决（蓝图强制登录，isAuthed=true；灵感模式 plan 全关）──
    const plan = planPersonalization(resolveMode(body.mode, true, body.useCreatorModel))

    // ── 查询风格卡：仅我的模式注入（统一 repo，未迁移自动降级）；灵感模式整块跳过 ──
    // Creator Mode 第五阶段：我的模式下，蓝图构思者首先被锚定为"长期专属伙伴"，
    // 与正文生成同一身份口径，避免"蓝图按通用口味、正文按个人口味"的精分。
    const creatorIdentity = buildCreatorIdentity(plan.mode)
    let styleProfileText = creatorIdentity
      ? `${creatorIdentity.forWriter}\n\n本次任务是为这位创作者构思创作蓝图：选题切入、Hook、核心冲突与情绪曲线都要像 ta 本人的作品会自然生长出来的样子，而不是平台通用模板。`
      : ''
    if (plan.useStyleProfile) {
      const profile = await fetchCreatorStyleProfile(supabase, user.id)

      if (profile) {
      const p = profile as {
        tone_tags?: string[]
        pace_preference?: string
        common_opening?: string
        avg_length?: number
        style_dimensions?: unknown
        creator_personality?: unknown
        topic_preferences?: unknown
        favorite_elements?: unknown
        avoid_elements?: unknown
        ai_creator_summary?: unknown
        creator_report?: unknown
      }
      const toneTags = p.tone_tags?.length ? p.tone_tags.join('、') : '暂无'
      // 阶段 5：从反馈/定稿/选方向行为学习出的五维画像（样本不足时为空串）
      const learnedDims = formatStyleDimensions(p.style_dimensions)
      styleProfileText = `【用户的创作风格特征】\n语气：${toneTags}\n节奏：${p.pace_preference ?? '未知'}\n常用开头：${p.common_opening ?? '未知'}\n平均长度：${p.avg_length ?? 0} 字/篇\n请在蓝图中体现这些风格特征。${learnedDims ? `\n${learnedDims}` : ''}`
      // 我的模式：创作者人格影响创作方向（题材偏好/Hook/冲突的选取）
      const block = formatCreatorModel(p)
      if (block.text) {
        styleProfileText += `\n\n${block.text}\n请在蓝图的主题定位、Hook 与核心冲突选取上体现该创作者的母题偏好与人格气质；排斥元素不得出现在蓝图任何环节。`
      }
      }
    }

    // ── 阶段四：登场角色（显式内容资产，两个模式都保留并约束蓝图）──
    const characters = sanitizeCharacterInput(body.characters)
    const characterBlock = formatCharactersForPrompt(characters)
    if (characterBlock.text) {
      styleProfileText += `${characterBlock.text}\n请在蓝图的叙事结构、核心冲突与 Hook 设计中围绕上述角色展开：主角/叙述者决定叙事视角，配角的进入时机要在 structure 中明确安排。`
    }

    // ── 调用 LLM 生成蓝图 ──
    const input: BlueprintInput = {
      topic,
      identityLabel,
      identity,
      style,
      category: resolvedCategory,
      wordCount,
      // 灵感模式不传历史记忆（blueprint.ts 中该段整块不渲染，零污染）
      ...(plan.useLocalMemory
        ? {
            memory: {
              identities: str(mem.identities, 300),
              styles: str(mem.styles, 300),
              categories: str(mem.categories, 300),
              favoredExcerpts: str(mem.favoredExcerpts ?? mem.favored, 1500),
            },
          }
        : {}),
      styleProfileText,
    }

    const blueprint = await generateBlueprint(input)
    if (!blueprint) {
      return NextResponse.json(
        { error: '创作蓝图生成失败，请稍后重试' },
        { status: 502 }
      )
    }

    return NextResponse.json({ blueprint })
  } catch (error) {
    console.error('creative blueprint API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
