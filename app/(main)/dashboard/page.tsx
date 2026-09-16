'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { CATEGORIES } from '@/lib/constants'
import { getWorks, deleteWork, type GeneratedWork } from '@/lib/works'
import {
  saveDashboardState,
  consumeReturnNavigation,
  restoreDashboardScroll,
  type DashboardScrollState,
} from '@/lib/scrollMemory'

const filterOptions = ['全部', ...CATEGORIES]

/** 灵感推荐数据结构 */
interface Inspiration {
  title: string
  description: string
  reason: string
  params: { category: string; topic: string }
}

export default function DashboardPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [works, setWorks] = useState<GeneratedWork[]>([])
  const [worksLoading, setWorksLoading] = useState(true)
  const [filter, setFilter] = useState('全部')
  const [inspirations, setInspirations] = useState<Inspiration[]>([])
  const [inspLoading, setInspLoading] = useState(true)
  // 返回素材库时待恢复的滚动记忆（仅 popstate 后的挂载有值）；筛选同步用 ref 供 pagehide 兜底
  const pendingRestoreRef = useRef<DashboardScrollState | null>(null)
  const filterRef = useRef(filter)
  useEffect(() => {
    // 在 effect 中同步 ref（不在渲染期写 ref），供 pagehide 兜底读取最新筛选
    filterRef.current = filter
  }, [filter])

  useEffect(() => {
    // 必须在任何异步/渲染前判定：本次挂载是否为「详情页返回（popstate）」。
    // 是则先恢复筛选，保证列表按原分类渲染（高度与离开时一致），滚动随后精确恢复。
    const { restore, state } = consumeReturnNavigation()
    if (restore && state) {
      pendingRestoreRef.current = state
      setFilter(state.filter)
    }

    async function init() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.replace('/login')
        return
      }
      setEmail(session.user.email ?? '')
      setWorks(getWorks())
      setWorksLoading(false)

      // 加载灵感推荐（失败不阻断页面）
      try {
        const res = await fetch('/api/inspirations', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data.inspirations)) {
            setInspirations(data.inspirations)
          }
        }
      } catch {
        // 网络异常，灵感区静默降级为空
      } finally {
        setInspLoading(false)
      }
    }
    init()
  }, [router])

  // 列表真实 DOM 提交后再恢复滚动：骨架屏阶段页面高度不足，恢复会被钳制为 0。
  // rAF 循环每帧按最新 scrollHeight 重算上限，直到列表高度足以承载目标 scrollTop。
  useEffect(() => {
    if (worksLoading || !pendingRestoreRef.current) return
    const target = pendingRestoreRef.current
    const cancel = restoreDashboardScroll(target.y)
    pendingRestoreRef.current = null
    return cancel
  }, [worksLoading])

  // 兜底：页面被隐藏（浏览器跳转/关闭）时再存一次当前位置，防止非卡片点击的跳转路径丢失位置
  useEffect(() => {
    function onPageHide() {
      saveDashboardState(window.scrollY, filterRef.current)
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [])

  function handleDeleteWork(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm('确定要删除这个作品吗？删除后不可恢复')) return
    deleteWork(id)
    setWorks((prev) => prev.filter((w) => w.id !== id))
  }

  const filteredWorks =
    filter === '全部' ? works : works.filter((w) => w.category === filter)

  return (
    <div className="inner-page">
      <div className="inner-container">
        {/* ── 顶部：标题（退出按钮已由 Sidebar 统一提供）── */}
        <div className="inner-header">
          <div>
            <h1 className="inner-header-title">我的素材库</h1>
            <p className="inner-header-sub">{email}</p>
          </div>
        </div>

        {/* ── 功能入口：两张卡片式按钮 ── */}
        <div className="inner-actions">
          <Link href="/materials" className="inner-action-card">
            <div className="inner-action-icon indigo">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h16M4 12h16M4 18h10" />
              </svg>
            </div>
            <div>
              <div className="inner-action-title">我的素材</div>
              <div className="inner-action-desc">管理原始文案，建立你的风格库</div>
            </div>
          </Link>
          <Link href="/generate" className="inner-action-card">
            <div className="inner-action-icon emerald">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <div>
              <div className="inner-action-title">新建生成任务</div>
              <div className="inner-action-desc">AI 学习你的风格，快速生成解说</div>
            </div>
          </Link>
        </div>

        {/* ── 风格卡入口 ── */}
        <Link href="/style-profile" className="inner-action-card" style={{ marginBottom: '40px' }}>
          <div className="inner-action-icon" style={{ background: 'rgba(168,85,247,0.15)', color: '#c084fc' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7l9-4 9 4-9 4-9-4z" />
              <path d="M3 12l9 4 9-4M3 17l9 4 9-4" />
            </svg>
          </div>
          <div>
            <div className="inner-action-title">我的风格卡</div>
            <div className="inner-action-desc">查看你的创作风格特征与语气偏好</div>
          </div>
        </Link>

        {/* ── 分类筛选 ── */}
        <div className="inner-filter-bar">
          {filterOptions.map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={`inner-filter-chip ${filter === cat ? 'active' : ''}`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* ── 灵感推荐（置于作品列表之上，优先激发创作） ── */}
        <div className="inner-section-head">
          <h2 className="inner-section-title">灵感推荐</h2>
        </div>

        {inspLoading ? (
          <div className="inner-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="inner-item" style={{ height: 88 }} />
            ))}
          </div>
        ) : inspirations.length > 0 ? (
          <div className="inner-list">
            {inspirations.map((ins, idx) => (
              <div
                key={idx}
                onClick={() =>
                  router.push(
                    `/generate?category=${encodeURIComponent(ins.params.category)}&topic=${encodeURIComponent(ins.params.topic)}`
                  )
                }
                className="inner-item clickable"
              >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h3 className="inner-item-title">{ins.title}</h3>
                  <p className="text-sm text-zinc-500 mt-1 line-clamp-2">{ins.description}</p>
                  <span className="inner-item-tag" style={{ marginTop: '8px', display: 'inline-block' }}>
                    {ins.reason}
                  </span>
                </div>
                <svg className="shrink-0 text-zinc-600 mt-1" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="inner-empty">
            <p>暂无灵感推荐</p>
            <p className="sub">多生成几篇作品后，系统会根据你的偏好推荐选题</p>
          </div>
        )}

        {/* ── 区块标题 + 计数 ── */}
        <div className="inner-section-head" style={{ marginTop: '48px' }}>
          <h2 className="inner-section-title">生成作品</h2>
          {!worksLoading && (
            <span className="inner-section-count">共 {works.length} 篇</span>
          )}
        </div>

        {/* ── 作品列表 ── */}
        {worksLoading ? (
          <div className="inner-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="inner-item" style={{ height: 72 }} />
            ))}
          </div>
        ) : filteredWorks.length === 0 ? (
          <div className="inner-empty">
            <p>
              {filter === '全部' ? '还没有生成作品' : `暂无「${filter}」分类的作品`}
            </p>
            <p className="sub">点击上方「新建生成任务」，AI 将基于你的素材库进行创作</p>
          </div>
        ) : (
          <div className="inner-list">
            {filteredWorks.map((w) => (
              <div
                key={w.id}
                onClick={() => {
                  // 跳转前记录精确位置与筛选，返回（popstate）后据此恢复
                  saveDashboardState(window.scrollY, filter)
                  // 第三阶段：作品统一进入创作空间 /article（版本/诊断/迭代），
                  // /works/[id] 仅作为老链接的重定向兼容层保留
                  router.push(`/article/${w.id}`)
                }}
                className="inner-item clickable"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="inner-item-title">{w.title}</h3>
                    <div className="inner-item-meta">
                      {w.solution && <span className="inner-item-tag">问题求解</span>}
                      <span className="inner-item-tag">{w.category}</span>
                      {w.identityLabel && (
                        <span className="inner-item-tag">
                          {w.identityLabel.length > 24 ? `${w.identityLabel.slice(0, 24)}…` : w.identityLabel}
                        </span>
                      )}
                      <span className="inner-item-date">
                        {new Date(w.created_at).toLocaleDateString('zh-CN')}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={(e) => handleDeleteWork(w.id, e)}
                    className="text-xs text-zinc-600 hover:text-red-400 transition shrink-0"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 右下角浮动：添加素材快捷入口 */}
      <Link href="/add" className="inner-fab">
        <span className="inner-fab-label">添加素材</span>
        <span className="inner-fab-plus">+</span>
      </Link>
    </div>
  )
}
