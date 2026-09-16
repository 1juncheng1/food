'use client'

// ============================================================
// /solutions —— 问题历史页
//
// 数据来源：generation_history 表，筛选 blueprint 含 solution_result 的行
// （解决方案的标记字段，与正文作品区分）。每行一个版本，按 id 去重保留最新版本，
// 按创建时间倒序展示。
//
// 零新增 API：直接用浏览器端 Supabase 客户端走 RLS 查询。
// 零新增表：generation_history 已覆盖原始问题+方案+版本+反馈全部数据。
// ============================================================

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'

interface SolutionRow {
  id: string
  topic: string
  category: string | null
  style: string | null
  identity_label: string | null
  created_at: string
  blueprint: {
    problem_understanding?: {
      problem_type?: string
      user_goal?: string
    } | null
    solution_result?: {
      title?: string
      summary?: string
    } | null
  } | null
}

/** 展示用条目（一个条目=一个问题，含最新版本信息 + 版本数） */
interface SolutionItem {
  id: string // 主行 id（去掉 ::vN 后缀）
  topic: string
  problemType: string
  userGoal: string
  solutionTitle: string
  solutionSummary: string
  role: string
  versionCount: number
  latestCreatedAt: string
}

export default function SolutionsPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<SolutionItem[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session) {
        router.replace('/login')
        return
      }

      try {
        // 查询所有 blueprint 含 solution_result 的行（解决方案版本行）
        // RLS 保证只能看到自己的数据
        const { data, error: queryError } = await supabase
          .from('generation_history')
          .select('id, topic, category, style, identity_label, created_at, blueprint')
          .not('blueprint', 'is', null)
          .order('created_at', { ascending: false })
          .limit(200) // 上限保护：最近 200 条版本行

        if (queryError) throw queryError

        // 客户端筛选：blueprint 含 solution_result 的行 = 解决方案
        const solutionRows = (data as unknown as SolutionRow[]).filter(
          (row) => row?.blueprint?.solution_result
        )

        // 按 id 前缀分组（genId + genId::v2 + genId::v3 → 一组）
        // 主 id = 去掉 ::vN 后缀
        const getBaseId = (rowId: string): string =>
          rowId.replace(/::v\d+$/, '')

        const groups = new Map<string, SolutionRow[]>()
        for (const row of solutionRows) {
          const baseId = getBaseId(row.id)
          const group = groups.get(baseId)
          if (group) {
            group.push(row)
          } else {
            groups.set(baseId, [row])
          }
        }

        // 每组取最新版本（created_at 最大），组装展示条目
        const result: SolutionItem[] = []
        for (const [baseId, rows] of groups) {
          // 按时间倒序，最新版在前
          rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          const latest = rows[0]
          const problem = latest.blueprint?.problem_understanding
          const solution = latest.blueprint?.solution_result

          result.push({
            id: baseId,
            topic: latest.topic || solution?.title || '未命名问题',
            problemType: problem?.problem_type || latest.category || '',
            userGoal: problem?.user_goal || '',
            solutionTitle: solution?.title || latest.topic || '',
            solutionSummary: solution?.summary || '',
            role: latest.identity_label || '',
            versionCount: rows.length,
            latestCreatedAt: latest.created_at,
          })
        }

        // 按最新版本创建时间倒序
        result.sort(
          (a, b) =>
            new Date(b.latestCreatedAt).getTime() - new Date(a.latestCreatedAt).getTime()
        )

        setItems(result)
      } catch (e) {
        console.error('问题历史加载失败:', e)
        setError('加载失败，请刷新页面重试')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [router])

  return (
    <div className="inner-page">
      <div className="inner-container">
        <div className="inner-header">
          <div className="text-center">
            <Link href="/generate" className="inner-back">← 返回灵感场</Link>
            <span className="gen-eyebrow">问题求解</span>
            <h1 className="inner-header-title">我的问题历史</h1>
            <p className="inner-header-sub">所有提出过的问题与解决方案</p>
          </div>
        </div>

        {/* 加载态 */}
        {loading && (
          <div className="inner-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="inner-item" style={{ height: 80 }} />
            ))}
          </div>
        )}

        {/* 错误态 */}
        {!loading && error && (
          <div className="inner-empty">
            <p>{error}</p>
          </div>
        )}

        {/* 空态 */}
        {!loading && !error && items.length === 0 && (
          <div className="inner-empty">
            <p>还没有提出过问题</p>
            <p className="sub">去灵感场提出一个问题，AI 会理解你的需求并生成解决方案</p>
            <Link href="/generate" className="mt-4 inline-block text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition">
              去提出问题 →
            </Link>
          </div>
        )}

        {/* 列表 */}
        {!loading && !error && items.length > 0 && (
          <div className="inner-section-head">
            <h2 className="inner-section-title">全部问题</h2>
            <span className="inner-section-count">共 {items.length} 个</span>
          </div>
        )}
        {!loading && !error && items.length > 0 && (
          <div className="inner-list">
            {items.map((item) => (
              <div
                key={item.id}
                onClick={() => router.push(`/solution/${item.id}`)}
                className="inner-item clickable"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="inner-item-title">{item.solutionTitle || item.topic}</h3>
                    {item.solutionSummary && (
                      <p className="text-sm text-zinc-500 mt-1 line-clamp-2">{item.solutionSummary}</p>
                    )}
                    <div className="inner-item-meta">
                      <span className="inner-item-tag">问题求解</span>
                      {item.problemType && (
                        <span className="inner-item-tag">{item.problemType}</span>
                      )}
                      {item.versionCount > 1 && (
                        <span className="inner-item-tag">V{item.versionCount}</span>
                      )}
                      {item.role && (
                        <span className="inner-item-tag">
                          {item.role.length > 24 ? `${item.role.slice(0, 24)}…` : item.role}
                        </span>
                      )}
                      <span className="inner-item-date">
                        {new Date(item.latestCreatedAt).toLocaleDateString('zh-CN')}
                      </span>
                    </div>
                  </div>
                  <svg className="shrink-0 text-zinc-600 mt-1" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
