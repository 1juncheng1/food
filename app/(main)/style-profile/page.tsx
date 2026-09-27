'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Sparkles } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import type { CreatorReport, DnaItem } from '@/lib/creative/creatorReport'
import { buildTasteView, TASTE_SOURCE_LABEL } from '@/lib/creative/tasteView'
import {
  AiStatus,
  EmptyState,
  ErrorState,
  PageHeader,
  PageShell,
  SkeletonList,
  TagChip,
} from '@/components/vision'

// ────────────────────────────────────────────────────────────
// 风格卡页面：展示从历史内容统计出的创作风格特征，支持手动编辑
// 数据来源：/api/style-profile（GET 获取/自动统计，POST 手动编辑）
// ────────────────────────────────────────────────────────────

/** 风格卡数据结构 */
interface StyleProfile {
  tone_tags: string[]
  pace_preference: string
  common_opening: string
  avg_length: number
  source: string
  updated_at?: string
  // ── Creator Model（个人创作者模型）──
  creator_personality?: string | null
  topic_preferences?: string[] | null
  favorite_elements?: string[] | null
  avoid_elements?: string[] | null
  ai_creator_summary?: string | null
  model_meta?: {
    summaryUpdatedAt?: string
    workSampleCount?: number
    materialSampleCount?: number
    signalCount?: number
    reportVersion?: number
  } | null
  /** 9.6 版本化创作 DNA 报告（{} 或 null 视为无报告，回退旧总结展示） */
  creator_report?: CreatorReport | Record<string, never> | null
  /** AI 协作修改：从修改行为聚合的编辑偏好记忆（P5 可视化） */
  editing_profile?: {
    preferences?: Array<{
      type: 'like' | 'avoid'
      statement: string
      confidence: number
      sourceCount: number
      examples?: string[]
    }>
    samples?: number
    updatedAt?: string
  } | null
  /** 用户主动声明（Creator Memory，含「我是谁」三问） */
  creator_declaration?: unknown
  /** Creator Understanding Engine 兴趣画像（CIP） */
  interest_profile?: unknown
  /** 五维行为画像（like/dislike/定稿/选方向学习所得） */
  style_dimensions?: unknown
}

/** /api/style-profile/summarize 的分型错误（code 与后端 ErrCode 对齐） */
interface SummarizeError {
  message: string
  code: string
  /** 限流时服务端给出的建议等待秒数 */
  retryAfter?: number
}

/** 可选语气标签池：编辑时用户可从中点选或移除 */
const ALL_TONE_TAGS = ['犀利', '幽默', '温情', '悬疑', '热血', '专业']

/** 节奏偏好可选项 */
const PACE_OPTIONS = ['快节奏', '慢节奏', '中等', '未知']

/** 开头方式可选项 */
const OPENING_OPTIONS = ['提问式', '叙事式', '未知']

export default function StyleProfilePage() {
  const router = useRouter()
  const [profile, setProfile] = useState<StyleProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 编辑模式状态
  const [editing, setEditing] = useState(false)
  const [editToneTags, setEditToneTags] = useState<string[]>([])
  const [editPace, setEditPace] = useState('')
  const [editOpening, setEditOpening] = useState('')
  const [saving, setSaving] = useState(false)
  // Creator Model 编辑态
  const [editPersonality, setEditPersonality] = useState('')
  const [editTopics, setEditTopics] = useState<string[]>([])
  const [editFav, setEditFav] = useState<string[]>([])
  const [editAvoid, setEditAvoid] = useState<string[]>([])
  // AI 总结刷新状态 + 本次返回的人格名建议（不自动覆盖，用户点「采用」才写入）
  const [summarizing, setSummarizing] = useState(false)
  const [suggestedPersonality, setSuggestedPersonality] = useState<string | null>(null)
  // AI 理解的分型错误（独立于页面级 error，按 code 给不同引导）
  const [summarizeError, setSummarizeError] = useState<SummarizeError | null>(null)
  // 同步防连点：state 异步，同一渲染帧内的双击需要 ref 兜底（服务端另有在途去重）
  const summarizeInflight = useRef(false)
  // 语言事实重新统计（确定性计算，不调 AI）
  const [recomputing, setRecomputing] = useState(false)
  // AI 协作修改（P5）：移除单条修改偏好记忆
  const [removingPreference, setRemovingPreference] = useState(false)
  // 知识优势：已确认知识条数 + 主要领域（只做展示，失败静默）
  const [knowledge, setKnowledge] = useState<{ count: number; domains: string[] } | null>(
    null
  )

  useEffect(() => {
    async function init() {
      // 登录校验：未登录跳转登录页
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.replace('/login')
        return
      }
      await loadProfile(session.access_token)
      // 知识库只用于「我的知识优势」展示，失败不影响本页任何功能
      try {
        const res = await fetch('/api/creative/knowledge', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (res.ok) {
          const data = (await res.json()) as {
            units?: Array<{ status?: string; domainScope?: string[] }>
          }
          const confirmed = (data.units ?? []).filter((u) => u.status === '已确认')
          const domains: string[] = []
          for (const u of confirmed) {
            for (const d of u.domainScope ?? []) {
              if (!domains.includes(d)) domains.push(d)
            }
          }
          setKnowledge({ count: confirmed.length, domains: domains.slice(0, 4) })
        }
      } catch {
        // 静默：知识优势为空即可
      }
    }
    init()
  }, [router])

  /** 从 API 加载风格卡（不存在时服务端自动统计并创建） */
  async function loadProfile(token: string) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/style-profile', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.error ?? `加载失败（${res.status}）`)
        return
      }
      const data = (await res.json()) as { profile: StyleProfile }
      setProfile(data.profile)
    } catch {
      setError('网络异常，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  /** 进入编辑模式：用当前值预填编辑表单 */
  function startEdit() {
    if (!profile) return
    setEditToneTags(profile.tone_tags ?? [])
    setEditPace(profile.pace_preference)
    setEditOpening(profile.common_opening)
    setEditing(true)
  }

  /** 切换语气标签选中状态 */
  function toggleTag(tag: string) {
    setEditToneTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    )
  }

  /** 保存编辑：调用 POST API，成功后更新展示状态 */
  async function handleSave() {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.replace('/login')
        return
      }
      const res = await fetch('/api/style-profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          toneTags: editToneTags,
          pacePreference: editPace,
          commonOpening: editOpening,
          avgLength: profile?.avg_length ?? 0,
          creatorPersonality: editPersonality,
          topicPreferences: editTopics,
          favoriteElements: editFav,
          avoidElements: editAvoid,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.error ?? `保存失败（${res.status}）`)
        return
      }
      const data = (await res.json()) as { profile: StyleProfile }
      setProfile(data.profile)
      setEditing(false)
    } catch {
      setError('网络异常，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  /** AI 协作修改（P5）：移除单条修改偏好记忆（本地即时移除，失败回滚重取） */
  async function handleRemovePreference(type: 'like' | 'avoid', statement: string) {
    if (removingPreference || !profile) return
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      router.replace('/login')
      return
    }
    setRemovingPreference(true)
    const prevProfile = profile
    // 乐观更新：先移除再请求，失败回滚
    setProfile({
      ...profile,
      editing_profile: {
        ...profile.editing_profile,
        preferences: (profile.editing_profile?.preferences ?? []).filter(
          (p) => !(p.type === type && p.statement === statement)
        ),
      },
    })
    try {
      const res = await fetch('/api/style-profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ removePreference: { type, statement } }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? '移除失败')
    } catch {
      setProfile(prevProfile) // 回滚
      setError('移除失败，请稍后重试')
    } finally {
      setRemovingPreference(false)
    }
  }

  async function handleRecompute() {
    if (recomputing) return
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      router.replace('/login')
      return
    }
    setRecomputing(true)
    setError(null)
    try {
      const res = await fetch('/api/style-profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ recompute: true }),
      })
      const data = (await res.json().catch(() => null)) as
        | { profile?: StyleProfile; error?: string }
        | null
      if (!res.ok || !data?.profile) {
        setError(data?.error ?? `重新统计失败（${res.status}）`)
        return
      }
      setProfile(data.profile)
    } catch {
      setError('网络异常，请稍后重试')
    } finally {
      setRecomputing(false)
    }
  }

  /** 让 AI 重新理解"我是谁"：只能手动触发；结果缓存于数据库，刷新页面不会重复调用 */
  async function handleSummarize() {
    // 双层防重入：ref 拦同一帧双击，state 拦跨事件重复点击；服务端还有在途请求折叠
    if (summarizing || summarizeInflight.current) return
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      router.replace('/login')
      return
    }
    summarizeInflight.current = true
    setSummarizing(true)
    setSummarizeError(null)
    setSuggestedPersonality(null)
    try {
      const res = await fetch('/api/style-profile/summarize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      const data = (await res.json().catch(() => null)) as
        | {
            success?: boolean
            summary?: string
            suggestedPersonality?: string
            report?: CreatorReport
            error?: string
            code?: string
            retryAfter?: number
          }
        | null
      if (!res.ok || !data?.summary) {
        setSummarizeError({
          message: data?.error ?? `AI 总结失败（${res.status}）`,
          code: data?.code ?? 'unknown',
          retryAfter: typeof data?.retryAfter === 'number' ? data.retryAfter : undefined,
        })
        return
      }
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              ai_creator_summary: data.summary ?? prev.ai_creator_summary,
              creator_report: data.report ?? prev.creator_report,
              model_meta: data.report
                ? {
                    summaryUpdatedAt: data.report.updatedAt,
                    workSampleCount: data.report.sources.works,
                    materialSampleCount: data.report.sources.materials,
                    signalCount: data.report.sources.signals,
                    reportVersion: data.report.version,
                  }
                : prev.model_meta,
            }
          : prev
      )
      if (data.suggestedPersonality) setSuggestedPersonality(data.suggestedPersonality)
    } catch {
      setSummarizeError({ message: '网络异常，请稍后重试', code: 'network' })
    } finally {
      setSummarizing(false)
      summarizeInflight.current = false
    }
  }

  /** 采纳 AI 建议的人格名（只写人格名，其余字段按当前值全量带上，避免被清空） */
  async function handleAdoptPersonality(name: string) {
    if (saving || !profile) return
    setSaving(true)
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.replace('/login')
        return
      }
      const res = await fetch('/api/style-profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          toneTags: profile.tone_tags,
          pacePreference: profile.pace_preference,
          commonOpening: profile.common_opening,
          avgLength: profile.avg_length,
          creatorPersonality: name,
          topicPreferences: profile.topic_preferences ?? [],
          favoriteElements: profile.favorite_elements ?? [],
          avoidElements: profile.avoid_elements ?? [],
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.error ?? `保存失败（${res.status}）`)
        return
      }
      const data = (await res.json()) as { profile: StyleProfile }
      setProfile(data.profile)
      setSuggestedPersonality(null)
    } catch {
      setError('网络异常，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  /** 有效 DNA 报告（creator_report 为 {} / null 时回退旧总结展示） */
  const report: CreatorReport | null =
    profile?.creator_report &&
    typeof profile.creator_report === 'object' &&
    'version' in profile.creator_report &&
    typeof (profile.creator_report as CreatorReport).personality?.main === 'string'
      ? (profile.creator_report as CreatorReport)
      : null
  /** 展示用人格名：用户手动命名优先（与生成注入口径一致） */
  const displayPersonality =
    profile?.creator_personality || report?.personality.main || ''

  // ── AI 理解报告四段式的数据派生（全部来自已加载数据，不新增判断逻辑）──
  const expressionTags = Array.from(
    new Set([
      ...(report?.languageDna.aiLabels ?? []),
      ...(profile?.tone_tags ?? []),
    ])
  ).slice(0, 6)
  const expressionSummary = report
    ? `${report.languageDna.pace !== '未知' ? report.languageDna.pace : '节奏未定'} · 平均 ${report.languageDna.avgLength} 字/篇`
    : profile
      ? `平均 ${profile.avg_length} 字/篇`
      : ''
  const domainTags = Array.from(
    new Set([
      ...(profile?.topic_preferences ?? []),
      ...(report?.motifDna.map((d) => d.label) ?? []),
    ])
  ).slice(0, 6)
  /** Creator Taste：四路信号合成的品味视图（纯函数，客户端即可算，无需新接口） */
  const taste = buildTasteView({
    declaration: profile?.creator_declaration,
    report: profile?.creator_report,
    editingProfile: profile?.editing_profile,
    interestProfile: profile?.interest_profile,
    styleDimensions: profile?.style_dimensions,
  })

  /** 创作习惯：叙事结构特征 + 你在修改中表达过的偏好（like 类） */
  const habitItems = [
    ...(report?.narrativeDna.map((d) => `常用结构：${d.label}`) ?? []),
    ...(profile?.editing_profile?.preferences ?? [])
      .filter((p) => p.type === 'like')
      .slice(0, 2)
      .map((p) => p.statement),
  ].slice(0, 4)

  /** 语言事实四卡（确定性统计）：有 DNA 报告时收入折叠区，主视图聚焦人格与 DNA */
  const languageFactsCards = profile ? (
    <div className="vs-archive">
      <div>
        <p className="vs-mark">语气标签</p>
        {profile.tone_tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {profile.tone_tags.map((tag) => (
              <TagChip key={tag} tone="neutral" size="sm">
                {tag}
              </TagChip>
            ))}
          </div>
        ) : (
          <p className="vs-note mt-2">暂未检测到明显的语气特征</p>
        )}
      </div>

      <div>
        <p className="vs-mark">节奏偏好</p>
        <p className="mt-2 text-[14px] text-[var(--vs-ink-2)]">{profile.pace_preference}</p>
      </div>

      <div>
        <p className="vs-mark">常用开头方式</p>
        <p className="mt-2 text-[14px] text-[var(--vs-ink-2)]">{profile.common_opening}</p>
      </div>

      <div>
        <p className="vs-mark">平均内容长度</p>
        <p className="mt-2 text-[14px] text-[var(--vs-ink-2)]">
          {profile.avg_length} <span className="vs-note">字/篇</span>
        </p>
      </div>
    </div>
  ) : null

  return (
    <PageShell>
      <Link href="/dashboard" className="vs-link mb-5">
        ← 返回创作机会
      </Link>

      {/* 页面定位：这不是个人资料，而是 AI 的理解报告 */}
      <PageHeader
        eyebrow="AI 理解报告"
        title="AI 现在是这样理解你的"
        description="这不是一份个人资料，而是 AI 从你的作品、修改与素材里读出来的结论。它会直接决定 AI 帮你选题、起草和修改时的判断。"
        ai={
          <AiStatus
            task="profile"
            active={loading || summarizing || recomputing}
            variant="bar"
          />
        }
      />

      {/* ── 错误提示 ── */}
      {error && (
        <ErrorState
          className="mb-6"
          message={error}
          onRetry={() => {
            void (async () => {
              const { data: { session } } = await supabase.auth.getSession()
              if (session) await loadProfile(session.access_token)
            })()
          }}
        />
      )}

      {/* ── 加载中 ── */}
      {loading && <SkeletonList count={3} height={112} />}

      {/* ── 空数据兜底 ── */}
      {!loading && !profile && !error && (
        <EmptyState
          icon={<Sparkles size={18} />}
          title="AI 还没有足够的材料认识你"
          description="先完成几篇作品或沉淀一些素材。有了足够样本，这里会出现 AI 对你的完整理解报告。"
          actionLabel="开始第一次创作"
          actionHref="/generate"
        />
      )}

        {/* ── 风格卡展示 ── */}
        {!loading && profile && !editing && (
          <>
            {/* 来源标识 */}
            <div className="flex flex-wrap items-center gap-3 mb-6">
              <TagChip tone="neutral" size="sm">
                {profile.source === 'manual' ? '手动编辑' : '自动统计'}
              </TagChip>
              {profile.updated_at && (
                <span className="vs-note">
                  更新于 {new Date(profile.updated_at).toLocaleDateString('zh-CN')}
                </span>
              )}
            </div>

            {/* ── AI 理解报告四段式：表达特点 / 关注领域 / 知识优势 / 创作习惯 ── */}
            <div className="vs-archive mb-8">
              <div>
                <p className="vs-mark">我的表达特点</p>
                {expressionTags.length > 0 ? (
                  <>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {expressionTags.map((t) => (
                        <TagChip key={t} tone="brand" size="sm">
                          {t}
                        </TagChip>
                      ))}
                    </div>
                    <p className="vs-note mt-2.5">{expressionSummary}</p>
                  </>
                ) : (
                  <p className="vs-note mt-2 leading-relaxed">
                    样本还不够，AI 暂时没有形成稳定的表达判断。
                  </p>
                )}
              </div>

              <div>
                <p className="vs-mark">我的关注领域</p>
                {domainTags.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {domainTags.map((t) => (
                      <TagChip key={t} tone="neutral" size="sm">
                        {t}
                      </TagChip>
                    ))}
                  </div>
                ) : (
                  <p className="vs-note mt-2 leading-relaxed">
                    还没有稳定的主题倾向，继续创作，AI 会自己看出来。
                  </p>
                )}
              </div>

              <div>
                <p className="vs-mark">我的知识优势</p>
                {knowledge && knowledge.count > 0 ? (
                  <>
                    <p className="mt-2 text-[15px] font-medium text-[var(--vs-ink)]">
                      {knowledge.count} 条已确认知识
                    </p>
                    {knowledge.domains.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {knowledge.domains.map((d) => (
                          <TagChip key={d} tone="neutral" size="sm">
                            {d}
                          </TagChip>
                        ))}
                      </div>
                    )}
                    <p className="vs-note mt-2.5 leading-relaxed">
                      这些是你亲自确认过的判断，AI 会在创作时优先参考。
                    </p>
                  </>
                ) : (
                  <p className="vs-note mt-2 leading-relaxed">
                    去知识库确认几条知识，AI 才知道你真正擅长什么。
                  </p>
                )}
              </div>

              <div>
                <p className="vs-mark">我的创作习惯</p>
                {habitItems.length > 0 ? (
                  <ul className="mt-2 space-y-1.5">
                    {habitItems.map((h) => (
                      <li
                        key={h}
                        className="flex gap-2 text-[13px] leading-relaxed text-[var(--vs-ink-3)]"
                      >
                        <span className="shrink-0 text-[var(--vs-ink-5)]">·</span>
                        <span>{h}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="vs-note mt-2 leading-relaxed">
                    AI 还在观察你的结构与修改习惯。
                  </p>
                )}
              </div>
            </div>

            {/* ── 创作者人格 Creator Model ── */}
            <div className="border-t border-[var(--vs-line)] pt-6">
              <div className="flex items-start justify-between gap-6 flex-wrap">
                <div>
                  <p className="vs-mark">
                    你的创作者人格{profile.creator_personality ? '（你自己命名）' : ''}
                  </p>
                  <h2 className="vs-h2 mt-2">
                    {displayPersonality || (
                      <span className="font-normal text-[var(--vs-ink-4)]">
                        还没有人格定位——让 AI 认识你，或自己命名
                      </span>
                    )}
                    {displayPersonality &&
                      report?.personality.sub &&
                      !profile.creator_personality && (
                        <span className="ml-2 text-sm font-normal text-[var(--vs-ink-4)]">
                          × {report.personality.sub}
                        </span>
                      )}
                  </h2>
                </div>
                <button
                  onClick={handleSummarize}
                  disabled={summarizing}
                  className="vs-btn vs-btn-primary vs-btn-sm shrink-0"
                >
                  {summarizing && (
                    <span className="vs-ai-dots" aria-hidden="true">
                      <i className="vs-ai-dot" />
                      <i className="vs-ai-dot" />
                      <i className="vs-ai-dot" />
                    </span>
                  )}
                  {summarizing
                    ? '重新理解中'
                    : profile.ai_creator_summary
                      ? '让 AI 重新理解我'
                      : '让 AI 认识我'}
                </button>
              </div>

              {/* AI 理解：有 DNA 报告时展示结构化报告；否则回退旧版散文总结 */}
              {report ? (
                <>
                  <div className="mt-4 flex items-center gap-2.5 flex-wrap">
                    <ConfidenceBadge value={report.confidence} />
                    <span className="vs-note">
                      第 {report.version} 版理解 · 随创作持续成长
                    </span>
                  </div>
                  <p className="vs-body mt-3">{report.personality.description}</p>
                  <DnaSection report={report} />
                </>
              ) : profile.ai_creator_summary ? (
                <p className="vs-body mt-4">{profile.ai_creator_summary}</p>
              ) : (
                <p className="vs-note mt-4 leading-relaxed">
                  AI 会综合你的风格统计、创作反馈、近期作品和素材库，总结你持续关注的母题与语言特征。
                  总结仅作生成参考，你可以随时编辑或刷新。
                </p>
              )}

              {/* AI 理解失败的分型引导：样本不足去创作 / 限流等倒计时 / 其余可重试 */}
              {summarizeError && (
                <div className="vs-warn mt-3">
                  <p className="vs-note vs-note-warn leading-relaxed">
                    {summarizeError.message}
                    {summarizeError.code === 'rate_limited' && summarizeError.retryAfter
                      ? `（约 ${summarizeError.retryAfter} 秒后可再试）`
                      : ''}
                  </p>
                  <div className="mt-2 flex items-center gap-4">
                    {summarizeError.code === 'insufficient_samples' && (
                      <Link href="/generate" className="vs-link text-[13px]">
                        去创作一篇 →
                      </Link>
                    )}
                    {summarizeError.code !== 'rate_limited' &&
                      summarizeError.code !== 'insufficient_samples' && (
                        <button
                          onClick={handleSummarize}
                          disabled={summarizing}
                          className="vs-link text-[13px] disabled:opacity-50"
                        >
                          重试
                        </button>
                      )}
                  </div>
                </div>
              )}

              {/* AI 建议人格名（不自动覆盖，一键采纳） */}
              {suggestedPersonality && suggestedPersonality !== profile.creator_personality && (
                <div className="mt-4 flex items-center gap-4 flex-wrap border-t border-[var(--vs-line)] pt-3">
                  <span className="vs-note">
                    AI 建议人格名：
                    <span className="text-[var(--vs-ink)]">{suggestedPersonality}</span>
                  </span>
                  <button
                    onClick={() => handleAdoptPersonality(suggestedPersonality)}
                    disabled={saving}
                    className="vs-link text-[13px] disabled:opacity-50"
                  >
                    采用
                  </button>
                  <button onClick={() => setSuggestedPersonality(null)} className="vs-link text-[13px]">
                    忽略
                  </button>
                </div>
              )}

              {/* 依据透明化：报告口径来自报告自身；旧版总结读 model_meta */}
              {report ? (
                <p className="vs-note mt-3">
                  基于近 {report.sources.works} 篇作品、{report.sources.materials} 条素材、
                  {report.sources.signals} 条真实创作行为分析 · 更新于{' '}
                  {new Date(report.updatedAt).toLocaleDateString('zh-CN')}
                </p>
              ) : (
                profile.model_meta?.summaryUpdatedAt && (
                  <p className="vs-note mt-3">
                    基于近 {profile.model_meta.workSampleCount ?? 0} 篇作品、
                    {profile.model_meta.materialSampleCount ?? 0} 条素材分析 · 更新于{' '}
                    {new Date(profile.model_meta.summaryUpdatedAt).toLocaleDateString('zh-CN')}
                  </p>
                )
              )}

              {/* 声明类偏好：题材 / 喜欢 / 排斥 */}
              <div className="mt-6 grid sm:grid-cols-3 gap-3">
                <CreatorTagGroup label="偏好题材" tags={profile.topic_preferences} />
                <CreatorTagGroup label="喜欢元素" tags={profile.favorite_elements} />
                <CreatorTagGroup label="排斥元素" tags={profile.avoid_elements} tone="avoid" />
              </div>

              {/* AI 协作修改（P5）：修改偏好记忆（从你的修改行为学习，可单条移除） */}
              {(profile.editing_profile?.preferences?.length ?? 0) > 0 && (
                <div className="mt-6 border-t border-[var(--vs-line)] pt-4">
                  <p className="vs-mark">修改偏好记忆</p>
                  <p className="vs-note mt-1.5">
                    来自你的 {profile.editing_profile?.samples ?? 0} 次真实修改行为，AI
                    生成时会自动参考
                  </p>
                  <div className="mt-2">
                    {profile.editing_profile!.preferences!.map((p, i) => (
                      <div key={`${p.type}-${i}`} className="vs-record-row">
                        <div className="min-w-0">
                          <p className="text-[13px] leading-relaxed text-[var(--vs-ink-2)]">
                            <span
                              className={`mr-2 ${
                                p.type === 'like'
                                  ? 'text-[var(--vs-ink-4)]'
                                  : 'text-[#fca5a5]'
                              }`}
                            >
                              {p.type === 'like' ? '喜欢' : '避免'}
                            </span>
                            {p.statement}
                          </p>
                          <p className="vs-note mt-1">
                            {Math.round(p.confidence * 100)}% 置信 · {p.sourceCount} 次确认
                            {p.examples?.[0] ? ` · 例如："${p.examples[0].slice(0, 30)}"` : ''}
                          </p>
                        </div>
                        <button
                          onClick={() => handleRemovePreference(p.type, p.statement)}
                          disabled={removingPreference}
                          title="AI 推断不准确？移除后不再参考这条偏好"
                          className="vs-link text-[13px] shrink-0 disabled:opacity-40"
                        >
                          移除
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Creator Taste：四路信号合成的「你喜欢什么 / 不要什么」。
                  与上方「修改偏好记忆」的区别：那一块只有修改行为一路，
                  这一块是声明 + DNA 报告 + 修改行为 + 兴趣统计的合并视图，
                  每条都标注来源与置信度，让用户看得见、也知道凭什么这么说。 */}
              {taste.hasAny && (
                <div className="mt-6 border-t border-[var(--vs-line)] pt-4">
                  <p className="vs-mark">品味画像</p>
                  <p className="vs-note mt-1.5">
                    {taste.depth
                      ? `你满意的成品整体${taste.depth.label}（基于 ${taste.depth.samples} 次行为样本）· `
                      : ''}
                    合并了你主动声明、AI 归纳、修改行为与兴趣统计四路信号
                  </p>
                  <div className="mt-2">
                    {[...taste.likes, ...taste.avoids].map((s) => (
                      <div key={`${s.polarity}-${s.statement}`} className="vs-record-row">
                        <p className="text-[13px] leading-relaxed text-[var(--vs-ink-2)]">
                          <span
                            className={`mr-2 ${
                              s.polarity === 'like'
                                ? 'text-[var(--vs-ink-4)]'
                                : 'text-[#fca5a5]'
                            }`}
                          >
                            {s.polarity === 'like' ? '喜欢' : '避免'}
                          </span>
                          {s.statement}
                        </p>
                        <p className="vs-note mt-1">
                          {Math.round(s.confidence * 100)}% 置信 ·{' '}
                          {s.sources.map((src) => TASTE_SOURCE_LABEL[src]).join(' + ')} ·{' '}
                          {s.evidence}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 语言事实：有 DNA 报告时收入折叠区，主视图聚焦人格与 DNA */}
            {report ? (
              <details className="group mt-6">
                <summary className="vs-mark cursor-pointer select-none list-none transition-colors hover:text-[var(--vs-ink-3)]">
                  <span className="inline-block group-open:rotate-90 transition-transform mr-1.5">
                    ▸
                  </span>
                  语言事实（关键词统计 · 节奏 · 开头 · 篇幅）
                </summary>
                <div className="mt-4">{languageFactsCards}</div>
              </details>
            ) : (
              languageFactsCards
            )}

            {/* 操作按钮 */}
            <div className="flex flex-wrap gap-3 mt-8">
              <button onClick={startEdit} className="vs-btn vs-btn-ghost">
                编辑风格卡
              </button>
              <button
                onClick={handleRecompute}
                disabled={recomputing}
                className="vs-btn vs-btn-ghost"
                title="基于素材库与全部作品重新统计语气/节奏/开头/篇幅（不调用 AI，不影响你的人格声明）"
              >
                {recomputing && (
                  <span className="vs-ai-dots" aria-hidden="true">
                    <i className="vs-ai-dot" />
                    <i className="vs-ai-dot" />
                    <i className="vs-ai-dot" />
                  </span>
                )}
                {recomputing ? '统计中' : '重新统计语言特征'}
              </button>
            </div>

            <p className="vs-note mt-6">
              你的创作者人格、风格统计与素材偏好会在每次 AI 生成时自动参考；创作越多，AI 对你的理解越准
            </p>
          </>
        )}

        {/* ── 编辑模式 ── */}
        {!loading && profile && editing && (
          <>
            <div className="space-y-8 pt-2">
              {/* 语气标签编辑 */}
              <div>
                <p className="vs-mark">语气标签</p>
                <p className="vs-note mt-1.5">从下方标签中选择，或取消已选标签</p>
                <div className="flex flex-wrap gap-2 mt-3">
                  {ALL_TONE_TAGS.map((tag) => {
                    const selected = editToneTags.includes(tag)
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleTag(tag)}
                        data-on={selected}
                        className="vs-chip"
                      >
                        {selected ? '✓ ' : ''}
                        {tag}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* 节奏偏好编辑 */}
              <div>
                <p className="vs-mark">节奏偏好</p>
                <div className="flex flex-wrap gap-2 mt-3">
                  {PACE_OPTIONS.map((opt) => {
                    const selected = editPace === opt
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setEditPace(opt)}
                        data-on={selected}
                        className="vs-chip"
                      >
                        {selected ? '✓ ' : ''}
                        {opt}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* 常用开头编辑 */}
              <div>
                <p className="vs-mark">常用开头方式</p>
                <div className="flex flex-wrap gap-2 mt-3">
                  {OPENING_OPTIONS.map((opt) => {
                    const selected = editOpening === opt
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setEditOpening(opt)}
                        data-on={selected}
                        className="vs-chip"
                      >
                        {selected ? '✓ ' : ''}
                        {opt}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* 平均长度（只读展示） */}
              <div>
                <p className="vs-mark">平均内容长度</p>
                <p className="mt-2 text-[14px] text-[var(--vs-ink-2)]">
                  {profile.avg_length} 字/篇
                  <span className="vs-note ml-2">（自动统计，不可手动修改）</span>
                </p>
              </div>

              {/* ── Creator Model：创作者人格 ── */}
              <div className="pt-2 border-t border-[var(--vs-line)]">
                <h3 className="vs-h3">创作者人格</h3>
                <p className="vs-note mt-1.5">
                  这些是你对自己的声明，AI 生成时会优先遵循；AI 总结不会覆盖它们
                </p>

                {/* 人格名 */}
                <div className="mt-6">
                  <label className="vs-mark block mb-2">我的创作者人格</label>
                  <input
                    type="text"
                    value={editPersonality}
                    onChange={(e) => setEditPersonality(e.target.value.slice(0, 30))}
                    placeholder="例如：冷峻的都市观察者 / 用故事讲道理的人"
                    className="vs-input vs-input-field"
                  />
                </div>

                <div className="space-y-6 mt-6">
                  <TagEditor
                    label="偏好题材"
                    hint="AI 会优先围绕这些母题给你创作方向"
                    tags={editTopics}
                    onChange={setEditTopics}
                    placeholder="输入题材后回车，如：人物成长、创业故事"
                  />
                  <TagEditor
                    label="喜欢的元素"
                    hint="生成时会被有意识地加入"
                    tags={editFav}
                    onChange={setEditFav}
                    placeholder="如：真实细节、反转结尾、金句"
                  />
                  <TagEditor
                    label="排斥的元素"
                    hint="生成时作为硬禁忌避开"
                    tags={editAvoid}
                    onChange={setEditAvoid}
                    placeholder="如：说教、烂尾、堆砌辞藻"
                  />
                </div>
              </div>
            </div>

            {/* 保存/取消 */}
            <div className="flex flex-wrap gap-3 mt-8">
              <button
                onClick={handleSave}
                disabled={saving}
                className="vs-btn vs-btn-primary disabled:opacity-40"
              >
                {saving ? '保存中' : '保存修改'}
              </button>
              <button onClick={() => setEditing(false)} className="vs-btn vs-btn-ghost">
                取消
              </button>
            </div>
          </>
        )}
    </PageShell>
  )
}

// ────────────────────────────────────────────────────────────
// 展示态：人格标签组（偏好题材 / 喜欢 / 排斥），空组显示占位
// ────────────────────────────────────────────────────────────
function CreatorTagGroup({
  label,
  tags,
  tone = 'neutral',
}: {
  label: string
  tags?: string[] | null
  /** avoid = 硬禁忌，用语义红；其余一律中性，靠标题区分 */
  tone?: 'neutral' | 'avoid'
}) {
  const list = tags ?? []
  return (
    <div className="border-t border-[var(--vs-line)] pt-3">
      <p className="vs-mark">{label}</p>
      {list.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {list.map((t) => (
            <TagChip key={t} tone={tone === 'avoid' ? 'avoid' : 'neutral'} size="sm">
              {t}
            </TagChip>
          ))}
        </div>
      ) : (
        <p className="vs-note mt-2">未设置</p>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// 编辑态：回车/逗号添加标签，点 × 移除；最多 15 个
// ────────────────────────────────────────────────────────────
function TagEditor({
  label,
  hint,
  tags,
  onChange,
  placeholder,
}: {
  label: string
  hint: string
  tags: string[]
  onChange: (next: string[]) => void
  placeholder: string
}) {
  const [draft, setDraft] = useState('')

  function commit() {
    const val = draft.trim().slice(0, 30)
    if (val && !tags.includes(val) && tags.length < 15) {
      onChange([...tags, val])
    }
    setDraft('')
  }

  return (
    <div>
      <label className="vs-mark block mb-1.5">{label}</label>
      <p className="vs-note mb-3">{hint}</p>
      <div className="vs-tagedit">
        {tags.map((t) => (
          <span key={t} className="vs-chip-xs">
            {t}
            <button
              type="button"
              onClick={() => onChange(tags.filter((x) => x !== t))}
              className="text-[var(--vs-ink-5)] leading-none transition-colors hover:text-[var(--vs-ink)]"
              aria-label={`移除 ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={(e) => {
            // 支持粘贴逗号分隔一次输入多个
            const v = e.target.value
            if (/[,，]/.test(v)) {
              const parts = v.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
              const merged = [...tags]
              for (const p of parts) {
                if (!merged.includes(p) && merged.length < 15) merged.push(p.slice(0, 30))
              }
              onChange(merged)
              setDraft('')
            } else {
              setDraft(v)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Backspace' && !draft && tags.length > 0) {
              onChange(tags.slice(0, -1))
            }
          }}
          onBlur={commit}
          placeholder={tags.length >= 15 ? '最多 15 个' : placeholder}
          disabled={tags.length >= 15}
        />
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// DNA 报告展示：每个百分比都标注"关联 N 篇真实样本"，不做无依据分数
// ────────────────────────────────────────────────────────────

/** 置信度胶囊：值由样本量代码计算（<0.4 形成中 / <0.65 初步成型 / 否则相对稳定） */
function ConfidenceBadge({ value }: { value: number }) {
  // 三档只差文字层级，不引入第二套颜色：低置信不是"警告"，只是样本还不够
  const level =
    value < 0.4
      ? { text: '理解形成中', key: 'low' }
      : value < 0.65
        ? { text: '初步成型', key: 'mid' }
        : { text: '相对稳定', key: 'high' }
  return (
    <span
      className="vs-verdict"
      data-level={level.key}
      title="置信度由样本数量与真实创作行为数决定，不是 AI 的主观评分"
    >
      ◈ {level.text} · {Math.round(value * 100)}%
    </span>
  )
}

/** 单条 DNA 维度：标签 + 比例条 + 证据篇数与原文 */
function DnaBar({ item, total }: { item: DnaItem; total: number }) {
  const pct = Math.round(item.weight * 100)
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] text-[var(--vs-ink-2)]">{item.label}</span>
        <span className="vs-note shrink-0">
          {pct}% · 关联 {item.count}/{total} 篇
        </span>
      </div>
      <div className="vs-dna-track mt-2">
        <span className="vs-dna-fill" style={{ width: `${Math.max(pct, 6)}%` }} />
      </div>
      {item.evidence.length > 0 && (
        <p className="vs-note mt-1.5 truncate" title={`依据：${item.evidence.join('、')}`}>
          依据：{item.evidence.slice(0, 2).join('、')}
          {item.evidence.length > 2 ? ` 等 ${item.evidence.length} 篇` : ''}
        </p>
      )}
    </div>
  )
}

/** DNA 分组卡（主题 / 叙事） */
function DnaCard({
  title,
  items,
  total,
  empty,
}: {
  title: string
  items: DnaItem[]
  total: number
  empty: string
}) {
  return (
    <div className="border-t border-[var(--vs-line)] pt-3">
      <p className="vs-mark">{title}</p>
      {items.length > 0 ? (
        <div className="space-y-3">
          {items.map((d) => (
            <DnaBar key={d.label} item={d} total={total} />
          ))}
        </div>
      ) : (
        <p className="vs-note leading-relaxed">{empty}</p>
      )}
    </div>
  )
}

/** DNA 报告主体：主题/叙事（带证据比例）+ 语言（确定性命中 + AI 定性词） */
function DnaSection({ report }: { report: CreatorReport }) {
  const lang = report.languageDna
  return (
    <div className="mt-5">
      <div className="grid sm:grid-cols-2 gap-x-8 gap-y-5">
        <DnaCard
          title="主题 DNA（你在讲什么）"
          items={report.motifDna}
          total={report.sampleCount}
          empty="样本中还没有归纳出稳定母题——多创作几篇不同作品后再重新理解"
        />
        <DnaCard
          title="叙事 DNA（你怎么讲）"
          items={report.narrativeDna}
          total={report.sampleCount}
          empty="叙事特征仍在形成中——继续创作，AI 会观察你的开头与展开方式"
        />
      </div>
      <div className="border-t border-[var(--vs-line)] pt-3 mt-5">
        <p className="vs-mark">语言 DNA</p>
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {lang.aiLabels.map((w) => (
            <TagChip key={w} tone="brand" size="sm">
              {w}
            </TagChip>
          ))}
          {lang.measured.map((m) => (
            <TagChip key={m.label} tone="neutral" size="sm">
              <span title={`确定性语气词命中 ${m.count} 篇`}>
                {m.label}×{m.count}
              </span>
            </TagChip>
          ))}
          {lang.aiLabels.length === 0 && lang.measured.length === 0 && (
            <span className="vs-note">暂无稳定语言特征</span>
          )}
        </div>
        <p className="vs-note mt-2.5">
          {lang.pace !== '未知' ? `${lang.pace}` : '节奏未知'} · 平均 {lang.avgLength} 字/篇
          <span className="ml-2">（浅色签为关键词确定性命中，冷蓝签为 AI 归纳）</span>
        </p>
      </div>
    </div>
  )
}
