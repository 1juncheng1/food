'use client'

// ────────────────────────────────────────────────────────────
// 作品成长档案 /works
//
// 定位：不是文件列表，而是每篇作品的成长记录——
// 它经历了几个版本、被改了几次、你给过什么反馈、AI 诊断过什么。
// 数据来源：GET /api/creative/projects（只读，只返回本人项目）
// ────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  ArrowRight,
  GitBranch,
  MessageSquare,
  PenLine,
  Sparkles,
  Stethoscope,
} from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import {
  AiStatus,
  EmptyState,
  ErrorState,
  PageHeader,
  PageShell,
  Section,
  SkeletonList,
  StatRow,
  SurfaceCard,
  TagChip,
} from '@/components/vision'

interface ProjectVersion {
  /** 版本行 id：详情页 /article/{id} 用它定位 */
  id: string
  versionNumber: number
  createdAt: string
  userFeedback: string | null
  improveDirection: string | null
}

interface ArchiveProject {
  id: string
  title: string
  topic: string
  status: string
  currentVersion: number
  createdAt: string
  updatedAt: string
  versionCount: number
  revisionCount: number
  feedbackCount: number
  diagnosedCount: number
  liked: boolean
  versions: ProjectVersion[]
}

interface ArchiveSummary {
  workCount: number
  versionCount: number
  revisionCount: number
  feedbackCount: number
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  })
}

export default function WorksArchivePage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [projects, setProjects] = useState<ArchiveProject[]>([])
  const [summary, setSummary] = useState<ArchiveSummary | null>(null)

  async function load() {
    // 第一个 setState 之前先 await：effect 内不做同步 setState，避免级联渲染
    const { data: { session } } = await supabase.auth.getSession()
    setLoading(true)
    setError(null)
    try {
      if (!session) {
        setError('请先登录后再查看作品档案')
        return
      }
      const res = await fetch('/api/creative/projects', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        setError(data?.error ?? `加载失败（${res.status}）`)
        return
      }
      const data = (await res.json()) as {
        projects?: ArchiveProject[]
        summary?: ArchiveSummary
      }
      setProjects(data.projects ?? [])
      setSummary(data.summary ?? null)
    } catch {
      setError('网络异常，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // effect 内不做同步 setState：全部包在 async init 里，与 explore 页面口径一致
    async function init() {
      await load()
    }
    void init()
  }, [])

  return (
    <PageShell>
      <PageHeader
        eyebrow="作品成长档案"
        title="你的作品是这样长出来的"
        description="这里记录的不是文件，而是每一次修改、每一条反馈、每一次 AI 诊断。看得见过程，才知道自己进步在哪。"
        actions={
          <Link
            href="/generate"
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500"
          >
            <PenLine size={15} />
            开始新作品
          </Link>
        }
        ai={<AiStatus task="profile" active={loading} variant="bar" />}
      />

      {summary && (
        <StatRow
          className="mb-9"
          items={[
            { label: '作品', value: summary.workCount },
            { label: '累计版本', value: summary.versionCount },
            { label: '修改次数', value: summary.revisionCount },
            { label: '你的反馈', value: summary.feedbackCount },
          ]}
        />
      )}

      {error && <ErrorState className="mb-6" message={error} onRetry={load} />}

      <Section
        title="成长记录"
        description="点开任意一篇，可以继续和 AI 一起改它。"
      >
        {loading ? (
          <SkeletonList count={3} height={132} />
        ) : error ? null : projects.length === 0 ? (
          <EmptyState
            icon={<Sparkles size={18} />}
            title="还没有作品档案"
            description="完成第一篇作品后，这里会记录它的每个版本、每次修改和你给的反馈——AI 也会据此越来越懂你。"
            actionLabel="开始第一次创作"
            actionHref="/generate"
          />
        ) : (
          <div className="flex flex-col gap-3">
            {projects.map((p) => (
              <SurfaceCard key={p.id} className="vs-rise">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {p.status === 'finalized' && (
                        <TagChip tone="accent" size="sm">
                          已定稿
                        </TagChip>
                      )}
                      {p.liked && (
                        <TagChip tone="warm" size="sm">
                          你评价过很好
                        </TagChip>
                      )}
                      <TagChip tone="muted" size="sm">
                        {formatDate(p.createdAt)} 创建
                      </TagChip>
                    </div>

                    <h3 className="mt-2.5 text-[16px] font-semibold leading-snug text-white">
                      {p.title}
                    </h3>
                    {p.topic && p.topic !== p.title && (
                      <p className="mt-1 text-[13px] leading-relaxed text-zinc-400 line-clamp-2">
                        {p.topic}
                      </p>
                    )}

                    {/* 成长数据 */}
                    <div className="vs-divider my-3" />
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-zinc-500">
                      <span className="inline-flex items-center gap-1.5">
                        <GitBranch size={12} />
                        {p.versionCount} 个版本
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <PenLine size={12} />
                        修改 {p.revisionCount} 次
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <MessageSquare size={12} />
                        反馈 {p.feedbackCount} 条
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <Stethoscope size={12} />
                        AI 诊断 {p.diagnosedCount} 次
                      </span>
                    </div>

                    {/* 最近一次修改的反馈：让"成长"有具体内容 */}
                    {p.versions.length > 1 && (
                      <div className="mt-3 space-y-1.5">
                        {p.versions
                          .filter((v) => v.userFeedback)
                          .slice(-1)
                          .map((v) => (
                            <p
                              key={v.versionNumber}
                              className="text-[13px] leading-relaxed text-zinc-400"
                            >
                              <span className="text-zinc-500">
                                V{v.versionNumber} 你的反馈：
                              </span>
                              {v.userFeedback}
                            </p>
                          ))}
                      </div>
                    )}
                  </div>

                  {/* 详情页按版本行定位：用最新版本的 id，而不是项目 id */}
                  {p.versions.length > 0 && (
                    <Link
                      href={`/article/${p.versions[p.versions.length - 1].id}`}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-white/[0.1] px-3 py-1.5 text-[12px] font-medium text-zinc-300 transition hover:border-white/20 hover:text-white"
                    >
                      继续
                      <ArrowRight size={13} />
                    </Link>
                  )}
                </div>
              </SurfaceCard>
            ))}
          </div>
        )}
      </Section>
    </PageShell>
  )
}
