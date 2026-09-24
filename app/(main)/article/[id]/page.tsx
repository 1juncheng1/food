'use client'

// ============================================================
// 动态路由页面：/article/[id]
// - 文章数据保存在浏览器 localStorage（works 存储），刷新链接内容不丢失，无需后端数据库
// - 收藏状态保存在风格记忆（styleMemory），收藏 = 标记为用户偏爱范文
// ============================================================

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { getWork, patchWork, type GeneratedWork } from '@/lib/works'
import { getMemoryEntry, setFavorite } from '@/lib/styleMemory'
import { getTask, startGenerationTask, replanGeneration } from '@/lib/generationTask'
import { backToDashboard } from '@/lib/scrollMemory'
import type { CreativeBlueprint } from '@/lib/creative/blueprint'
import type { FrozenPlan } from '@/lib/creative/plan'
import { BlueprintCard } from '@/components/creative/blueprint-card'
import {
  parseDiagnosis,
  NEXT_ACTION_META,
  type CreativeDiagnosis,
  type NextActionKey,
} from '@/lib/creative/diagnosisMeta'
import { DiagnosisCard } from '@/components/creative/diagnosis-card'
import type { AlignmentReport } from '@/lib/creative/feedbackAlignment'
// Work Agent：用对话式共创替换原「自由反馈输入框」（保留其内部快捷方向入口）
import { WorkAgentChat } from '@/components/creative/work-agent-chat'
import { PerformanceCard } from '@/components/creative/performance-card'
import {
  AiStatus,
  PageHeader,
  PageShell,
  StatRow,
} from '@/components/vision'
import type { FeedbackAnalysis, RevisionPlan } from '@/lib/creative/workAgent'
import { formatFeedbackForPrompt } from '@/lib/creative/workAgent'
import type { ModificationPatch } from '@/lib/creative/patchEngine'
import type { InjectedUnitSummary } from '@/lib/creative/knowledgeInject'
import type { WorkTags } from '@/lib/creative/workAnalysis'
import ShareToPlazaModal from '@/components/share/share-to-plaza-modal'
import { CATEGORIES } from '@/lib/constants'
import { IDENTITY_TEMPLATES } from '@/lib/identityTemplates'
import { CHARACTER_ROLE_LABELS } from '@/lib/characters'
import { buildMemorySummary } from '@/lib/styleMemory'
import { supabase } from '@/lib/supabaseClient'

/** 创作项目的历史版本（GET /api/creative/projects/[id] 返回项） */
interface ProjectVersion {
  id: string
  versionNumber: number
  improveDirection: NextActionKey | null
  improveNote: string | null
  // 阶段 4 Work Agent：该版本基于哪条用户反馈生成（V2+ 才有值，V1 为 null）
  userFeedback: string | null
  sampleText: string
  systemPrompt: string | null
  blueprint: FrozenPlan | null
  analysis: CreativeDiagnosis | null
  feedbackStatus: string | null
  createdAt: string
  // ── Work Agent：本版本「改了什么 / 为什么改」的证据链 ──
  /** 服务端融合落地的段落补丁（原文摘录 + 修订文 + 理由） */
  editPatches: ModificationPatch[]
  /** 用户当时确认的修改方案快照（null=该版本不是 Work Agent 共创产出） */
  revisePlan: RevisionPlan | null
  /** 产出该版本的共创会话 id（可回放完整对话，本期前端暂不跳转） */
  sessionId: string | null
  /**
   * Creator Knowledge System Phase 3：本版本生成时依据的创作者知识单元。
   * 空数组 = 当时没参考任何知识（灵感模式/游客/无匹配单元），据此不渲染该区块。
   */
  usedKnowledge: InjectedUnitSummary[]
}

export default function ArticlePage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [work, setWork] = useState<GeneratedWork | null>(null)
  const [pending, setPending] = useState(true) // true = 生成任务进行中，展示 thinking 动画
  const [error, setError] = useState<string | null>(null)
  const [favorited, setFavorited] = useState(false)
  const [copied, setCopied] = useState<'sample' | null>(null)
  // ── 反馈状态 ──
  const [feedback, setFeedback] = useState<'like' | 'dislike' | 'edit' | 'regenerate' | null>(null)
  // 仅 👍/👎 走 toggle 接口；记录「哪个按钮的请求在飞行中」，只锁该按钮，不全屏屏蔽
  const [feedbackPending, setFeedbackPending] = useState<'like' | 'dislike' | null>(null)
  const feedbackInFlightRef = useRef(false) // 供轮询闭包判断，避免 GET 对账覆盖乐观状态
  const [feedbackError, setFeedbackError] = useState<string | null>(null) // 反馈失败提示（失败时回退 UI 状态）
  const [editMode, setEditMode] = useState(false)
  // 方向验收：定向迭代（改进/重写）落盘后，核对新版本是否真的落在用户要的方向上
  const [alignment, setAlignment] = useState<AlignmentReport | null>(null)
  const [aligning, setAligning] = useState(false)
  // 待验收基准（改动前的版本 + 用户的原话），新版本落盘后消费一次即清空
  const pendingAlignRef = useRef<{
    baseVersionId: string
    freeText: string
    intentLabel?: string
  } | null>(null)
  const [editedText, setEditedText] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  // ── 创作蓝图（两阶段生成：thinking 期展示，完成后可折叠回看）──
  const [blueprint, setBlueprint] = useState<FrozenPlan | null>(null)
  const [blueprintExpanded, setBlueprintExpanded] = useState(true)
  // 轮询重启信号：再来一版/换个方向时 +1，让 useEffect 重新开始监听任务
  const [reloadTick, setReloadTick] = useState(0)
  // ── 创作进化系统阶段 3：版本列表（仅属于 creative_projects 的作品有值）──
  const [versions, setVersions] = useState<ProjectVersion[]>([])
  // null = 展示最新版本（本地 work 镜像）；数字 = 只读查看指定历史版本
  const [activeVersion, setActiveVersion] = useState<number | null>(null)
  // ── 阶段 4：AI 五维诊断（最新版状态机；游客/无库行的作品 hidden 不渲染）──
  const [diagnosis, setDiagnosis] = useState<CreativeDiagnosis | null>(null)
  const [diagnosisStatus, setDiagnosisStatus] = useState<
    'idle' | 'loading' | 'done' | 'error' | 'hidden'
  >('idle')
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null)
  const [diagnosisRefreshing, setDiagnosisRefreshing] = useState(false)
  // 历史版本手动诊断中（记录 version 行 id）
  const [historyDiagId, setHistoryDiagId] = useState<string | null>(null)
  // ── 阶段 5：作品标签分析（异步加载，失败静默降级）──
  const [workTags, setWorkTags] = useState<WorkTags | null>(null)
  const [workTagsStatus, setWorkTagsStatus] = useState<
    'idle' | 'loading' | 'done' | 'error'
  >('idle')
  // ── 阶段 5：项目定稿状态 + 定向迭代进行中的方向 ──
  const [projectStatus, setProjectStatus] = useState<'active' | 'finalized' | null>(null)
  const [improvingDirection, setImprovingDirection] = useState<NextActionKey | null>(null)
  const [finalizeBusy, setFinalizeBusy] = useState(false)
  // ── 第三阶段：老作品「纳入持续创作」（adopt）──
  const [adopting, setAdopting] = useState(false)
  const [adoptError, setAdoptError] = useState<string | null>(null)
  // ── 作品→灵感广场分享弹窗 ──
  const [shareOpen, setShareOpen] = useState(false)
  // 定稿成功后的发布引导。定稿→发布转化曾长期为 0%，根因是定稿后页面完全静默：
  // 用户刚认可了作品，却没有任何提示告诉他「下一步可以让更多人看到」。
  const [justFinalized, setJustFinalized] = useState(false)

  /** 复制文本（clipboard API 失败时降级 execCommand） */
  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied('sample')
    setTimeout(() => setCopied(null), 1500)
  }

  // ── 数据加载：轮询任务状态，直到作品落盘（数据就绪才展示页面内容）──
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    // 轮询兜底：任务卡在 running 永不收敛时（请求挂死、或链路被中断后状态没回写），
    // 前端会 300ms 一次无限转下去，且 improvingDirection 永不复位，
    // 表现就是"点了改进之后一直转圈"。超过这个上限按失败处理，把控制权还给用户。
    const staleDeadline = Date.now() + 180_000
    // 本次 effect 生命周期内已与后端对过账的版本行 id（pid::vN 或本地 id）
    let feedbackLoadedFor: string | null = null
    // 阶段 5：work-tags 标签分析同样按版本行 id 去重
    let tagsLoadedFor: string | null = null
    // 切换文章时清空上一篇的蓝图/版本/诊断状态，避免 SPA 组件复用造成串显
    setBlueprint(null)
    setBlueprintExpanded(true)
    setVersions([])
    setActiveVersion(null)
    setDiagnosis(null)
    setDiagnosisStatus('idle')
    setDiagnosisError(null)
    setDiagnosisRefreshing(false)
    setHistoryDiagId(null)
    setWorkTags(null)
    setWorkTagsStatus('idle')
    setProjectStatus(null)
    setImprovingDirection(null)
    setFinalizeBusy(false)
    setAdopting(false)
    setAdoptError(null)
    // 反馈状态随文章切换全部归零，check() 落盘后按新行 id 重新与后端对账
    setFeedback(null)
    setFeedbackError(null)
    setFeedbackPending(null)
    feedbackInFlightRef.current = false
    setEditMode(false)

    function check(): boolean {
      const task = getTask(params.id)
      const running =
        task?.status === 'pending' ||
        task?.status === 'blueprint' ||
        task?.status === 'writing'

      // 1) 任务进行中 → 优先保持 thinking（即使 localStorage 里有同 id 旧作品）
      //    关键：「再来一版 / 换个方向」复用同一 id，旧作品一直存在，
      //    若先判作品会立刻停轮询导致 thinking 卡死、新结果永远刷不出来。
      if (running) {
        // 转圈上限：任务迟迟不收敛时不能无限等下去
        if (Date.now() > staleDeadline) {
          setImprovingDirection(null) // 先复位，否则共创面板与方向卡会永久禁用
          setError('生成时间过长已中断，请重新发起')
          setPending(false)
          return true
        }
        setPending(true)
        setError(null)
        if (task.blueprint) setBlueprint(task.blueprint)
        return false
      }

      // 2) 作品已落盘且无进行中任务 → 展示最新内容
      const w = getWork(params.id)
      if (w) {
        // 2a：非内容类问题的解决方案误入正文页（如从作品库/历史点入）
        // → 无缝重定向到专属结果页（诊断/迭代等正文交互对解决方案不适用）
        // Array.isArray 守卫：localStorage 数据损坏（sections 缺失/非数组）时按普通作品处理，不崩溃
        if (w.solution && Array.isArray(w.solution.sections) && w.solution.sections.length > 0) {
          router.replace(`/solution/${params.id}`)
          return true
        }
        setImprovingDirection(null) // 定向迭代任务已完成，恢复方向卡
        // 定向迭代刚落盘 → 触发一次方向验收。
        // 立即清空标记：轮询每 300ms 都会走到这里，不清会无限重复发起校验请求。
        if (pendingAlignRef.current && w.versionId) {
          const base = pendingAlignRef.current
          pendingAlignRef.current = null
          void verifyImproveAlignment(w.versionId, base)
        }
        setWork(w)
        if (w.blueprint) {
          setBlueprint(w.blueprint)
          setBlueprintExpanded(false) // 正文就绪后蓝图默认收起，不干扰阅读
        }
        setFavorited(getMemoryEntry(params.id)?.favorited ?? false)
        setPending(false)
        // 与后端对账反馈状态：按「当前落盘版本行 id」去重，作品首次落盘/迭代出 V2/V3 后都会拉取，
        // 保证刷新或新版本落地后按钮态与 feedback_status 完全一致（含取消后的 null）
        const feedbackKey = w.versionId ?? params.id
        if (feedbackLoadedFor !== feedbackKey) {
          feedbackLoadedFor = feedbackKey
          supabase.auth.getSession().then(({ data: { session } }) => {
            const headers: Record<string, string> = {}
            if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
            // 项目作品用真实版本行 id（pid::vN），老作品回退到本地 id
            fetch(`/api/feedback?id=${encodeURIComponent(feedbackKey)}`, { headers })
              .then((r) => (r.ok ? r.json() : null))
              .then((data: { feedbackStatus?: string | null } | null) => {
                // 用户刚点了 👍/👎、POST 尚在飞行中：不覆盖乐观状态（POST 返回后会以服务端为准对账）
                if (feedbackInFlightRef.current) return
                const map: Record<string, 'like' | 'dislike' | 'edit' | 'regenerate'> = {
                  like: 'like', dislike: 'dislike', edited: 'edit', regenerated: 'regenerate',
                }
                setFeedback(data?.feedbackStatus ? (map[data.feedbackStatus] ?? null) : null)
              })
              .catch(() => {})
          })
        }
        // ── 阶段 5：异步 fetch 作品标签分析（不阻塞阅读，失败静默）──
        // 与 feedback 对账同用版本行 id 去重，确保新版本落地后重新分析
        if (tagsLoadedFor !== feedbackKey && w.content.trim().length >= 20) {
          tagsLoadedFor = feedbackKey
          setWorkTagsStatus('loading')
          supabase.auth.getSession().then(({ data: { session } }) => {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' }
            if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
            fetch('/api/creative/work-tags', {
              method: 'POST',
              headers,
              body: JSON.stringify({
                generationId: feedbackKey,
                sampleText: w.content,
                topic: w.title,
              }),
            })
              .then((r) => r.ok ? r.json() : null)
              .then((data: { tags?: WorkTags } | null) => {
                if (data?.tags) {
                  setWorkTags(data.tags)
                  setWorkTagsStatus('done')
                } else {
                  setWorkTagsStatus('error')
                }
              })
              .catch(() => {
                setWorkTagsStatus('error')
              })
          })
        }
        return true
      }

      // 3) 任务失败 → 展示错误与恢复入口；恢复方向卡，避免定向迭代失败后永久 loading
      if (task?.status === 'error') {
        setImprovingDirection(null)
        setError(task.error ?? '生成失败，请重试')
        setPending(false)
        return true
      }

      // 4) 既无作品也无任务：链接错误，或生成途中刷新页面导致内存任务丢失
      //    必须复位 improvingDirection：任务已随刷新丢失，没有任何东西会再把它清掉，
      //    不清的话方向卡与 AI 共创面板会永久停留在"进行中"。
      setImprovingDirection(null)
      setError('文章不存在，或生成任务已中断（生成途中刷新页面会丢失任务）')
      setPending(false)
      return true
    }

    // 首次检查未就绪则每 300ms 轮询一次
    if (!check()) {
      timer = setInterval(() => {
        if (check()) clearInterval(timer)
      }, 300)
    }
    return () => {
      if (timer) clearInterval(timer)
    }
  }, [params.id, reloadTick, router])

  /** 收藏至灵感库 = 标记为用户偏爱范文，后续生成时 AI 会学习其语感、句式 */
  function handleFavorite() {
    const next = !favorited
    setFavorite(params.id, next)
    setFavorited(next)
  }

  /** 再次生成同款风格：把本次创作参数带到生成页自动预填表单 */
  function handleRegenerate() {
    if (!work) return
    const qs = new URLSearchParams()
    qs.set('topic', work.title)
    if (work.style) qs.set('style', work.style)
    // 类型：官方分类直接传；自定义类型走 custom 分支传文本
    if ((CATEGORIES as readonly string[]).includes(work.category)) {
      qs.set('category', work.category)
    } else {
      qs.set('category', 'custom')
      qs.set('customCategory', work.category)
    }
    // 身份：官方模板按名称反查 id 传回；已保存的自定义身份按名称匹配
    const tpl = IDENTITY_TEMPLATES.find((t) => t.name === work.identityLabel)
    if (tpl) {
      qs.set('template', tpl.id)
    } else if (work.identityLabel && !work.identityLabel.startsWith('自定义身份')) {
      qs.set('identity', work.identityLabel)
    }
    router.push(`/generate?${qs.toString()}`)
  }

  // ── 反馈：调用 /api/feedback，传入生成内容以延迟创建历史记录 ──
  // error 非 null 表示失败（用于界面提示）；feedbackStatus 为服务端确认后的真实状态（取消时为 null）
  async function submitFeedback(
    type: 'like' | 'dislike' | 'edit' | 'regenerate',
    editedContent?: string
  ): Promise<{ error: string | null; feedbackStatus: string | null }> {
    if (!work) return { error: '作品数据缺失，无法反馈', feedbackStatus: null }
    try {
      // session 存在 localStorage，需把 access_token 放进 Authorization 头传给服务端验证
      const { data: { session } } = await supabase.auth.getSession()
      // 反馈需要登录：未登录提前拦截，避免无效网络请求
      if (!session?.access_token) return { error: '请先登录后再反馈', feedbackStatus: null }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      }

      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          // 项目版本用真实版本行 id（pid::vN），否则 RPC 会补建一行脱离项目的历史
          generationId: work.versionId ?? params.id,
          feedbackType: type,
          editedContent: editedContent ?? null,
          // 延迟创建用：如果该 id 在数据库不存在，用这些数据创建
          topic: work.title,
          identityLabel: work.identityLabel,
          style: work.style,
          category: work.category,
          systemPrompt: work.systemPrompt,
          sampleText: work.content,
        }),
      })
      if (!res.ok) {
        // 优先展示服务端返回的具体错误（如"请先登录"、参数错误等）
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        return { error: data?.error ?? `反馈提交失败（${res.status}）`, feedbackStatus: null }
      }
      const data = (await res.json().catch(() => null)) as { feedbackStatus?: string | null } | null
      return { error: null, feedbackStatus: data?.feedbackStatus ?? null }
    } catch (err) {
      console.error('反馈请求异常:', err)
      return { error: '网络异常，请稍后重试', feedbackStatus: null }
    }
  }

  async function handleFeedback(type: 'like' | 'dislike') {
    // 同一时间只允许一个 👍/👎 请求在飞：挡住快速连点/并发切换，但不整体禁用按钮造成"点了没反应"
    if (feedbackInFlightRef.current) return
    const prevLike: 'like' | 'dislike' | null =
      feedback === 'like' || feedback === 'dislike' ? feedback : null
    const wasEditMode = editMode
    feedbackInFlightRef.current = true
    setFeedbackPending(type)
    setFeedbackError(null)
    setEditMode(false)
    // 乐观更新：点击瞬间高亮；再次点击已激活的按钮 = 立即取消；like/dislike 天然互斥
    setFeedback(prevLike === type ? null : type)

    const res = await submitFeedback(type)
    feedbackInFlightRef.current = false
    setFeedbackPending(null)
    if (res.error) {
      // 失败回滚到点击前的真实状态，并给出明确错误提示
      setFeedback(prevLike ?? (wasEditMode ? 'edit' : null))
      setEditMode(wasEditMode)
      setFeedbackError(res.error)
      return
    }
    // 成功：以服务端状态为准（toggle 取消时返回 null）
    setFeedback(
      res.feedbackStatus === 'like' || res.feedbackStatus === 'dislike'
        ? res.feedbackStatus
        : null
    )
  }

  async function handleEditStart() {
    if (!work) return
    setEditMode(true)
    setEditedText(work.content)
    setFeedback('edit')
  }

  async function handleEditSave() {
    if (!work || !editedText.trim() || savingEdit) return
    setSavingEdit(true)
    setFeedbackError(null)
    const result = await submitFeedback('edit', editedText.trim())
    setSavingEdit(false)
    if (result.error) {
      // 保存失败：保持编辑模式与已输入内容，提示错误
      setFeedbackError(result.error)
      return
    }
    // 更新本地作品内容
    const updated = { ...work, content: editedText.trim() }
    setWork(updated)
    // 同步更新 localStorage
    try {
      const { saveWork } = await import('@/lib/works')
      saveWork(updated)
    } catch { /* ignore */ }
    setEditMode(false)
  }

  async function handleRegenerateFeedback() {
    if (!work || feedbackInFlightRef.current) return
    setFeedback('regenerate')
    setRegenerating(true)
    // 记录反馈（不等待）
    void submitFeedback('regenerate')
    // 重新调用生成 API，复用当前作品的参数
    const genId = params.id // 复用同一个 id 覆盖当前结果
    const memory = buildMemorySummary()
    // 阶段 C：若原作品有创作方案（蓝图），直接带方案重写——
    //   1) 字数从方案取（不再硬编码 300）；
    //   2) 身份/品类/文风由后端从方案派生，不再反查身份模板（方案视角≠模板标签）；
    //   3) 无方案的老作品沿用旧逻辑。
    const hasPlan = !!work.blueprint
    const tpl = hasPlan ? undefined : IDENTITY_TEMPLATES.find((t) => t.name === work.identityLabel)
    const customIdentity = (!tpl && work.identityLabel && !work.identityLabel.startsWith('自定义身份'))
      ? work.identityLabel
      : undefined
    const bpWordCount =
      (work.blueprint as { word_count?: number } | null)?.word_count ??
      (work.systemPrompt?.match(/(\d+)\s*字/) ? Number(work.systemPrompt.match(/(\d+)\s*字/)![1]) : null)
    startGenerationTask(
      genId,
      {
        topic: work.title,
        templateId: tpl?.id,
        customIdentity,
        identityLabel: work.identityLabel ?? '通用解说者',
        style: work.style ?? '',
        wordCount: hasPlan ? (bpWordCount || 1200) : 300,
        category: (CATEGORIES as readonly string[]).includes(work.category) ? work.category : '自定义类型',
        customCategory: (CATEGORIES as readonly string[]).includes(work.category) ? '' : work.category,
        // 项目作品：在同一 creative_projects 下新增 V2/V3（后端 INSERT 新版本，不覆盖旧版本）
        projectId: work.projectId,
        // 阶段四：复用原作品的角色快照，保证再来一版时人设延续
        characters: work.characters ?? [],
        // Creator Mode：沿用原作品模式（老作品无记录时由后端按登录态裁决）
        mode: work.mode,
        memory,
        // 阶段 C：带方案重写（同一方向换一篇表达）
        plan: hasPlan ? (work.blueprint as import('@/lib/creative/plan').FrozenPlan) : undefined,
      },
      {
        title: work.title,
        identityLabel: work.identityLabel ?? '通用解说者',
        style: work.style ?? '',
        category: work.category,
      }
    )
    // 重启轮询监听新任务（旧实现仅 setPending(true)，轮询已停会导致 thinking 卡死）
    setRegenerating(false)
    setFeedback(null)
    setBlueprint(null)
    setBlueprintExpanded(true)
    setReloadTick((t) => t + 1)
  }

  /** 「换个方向」：中断当前蓝图/撰写，用相同表单参数重新构思（默认自动续写新蓝图） */
  function handleReplan() {
    const ok = replanGeneration(params.id)
    if (ok) {
      setBlueprint(null)
      setBlueprintExpanded(true)
      setError(null)
      setPending(true)
      setReloadTick((t) => t + 1) // 重启轮询监听新任务
    }
  }

  // ── 阶段 3：项目作品拉取 V1/V2/V3 版本列表（游客/老作品 projectId 为空，跳过）──
  useEffect(() => {
    const pid = work?.projectId
    if (!pid) {
      setVersions([])
      return
    }
    let cancelled = false
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.access_token || cancelled) return
      fetch(`/api/creative/projects/${encodeURIComponent(pid)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: {
          project?: { status?: string }
          versions?: Array<{
            id: string
            versionNumber: number
            improveDirection: string | null
            improveNote: string | null
            userFeedback?: string | null
            sampleText: string
            systemPrompt: string | null
            blueprint: CreativeBlueprint | null
            analysis: unknown
            feedbackStatus: string | null
            createdAt: string
            editPatches?: ModificationPatch[]
            revisePlan?: RevisionPlan | null
            sessionId?: string | null
            usedKnowledge?: InjectedUnitSummary[]
          }>
        } | null) => {
          if (cancelled || !data?.versions) return
          setProjectStatus(data.project?.status === 'finalized' ? 'finalized' : 'active')
          setVersions(
            data.versions.map((v): ProjectVersion => ({
              id: v.id,
              versionNumber: v.versionNumber,
              improveDirection:
                (v.improveDirection as NextActionKey | null) ?? null,
              improveNote: v.improveNote ?? null,
              userFeedback: v.userFeedback ?? null,
              sampleText: v.sampleText,
              systemPrompt: v.systemPrompt,
              blueprint: v.blueprint,
              analysis: parseDiagnosis(v.analysis),
              feedbackStatus: v.feedbackStatus,
              createdAt: v.createdAt,
              editPatches: Array.isArray(v.editPatches) ? v.editPatches : [],
              revisePlan: v.revisePlan ?? null,
              sessionId: v.sessionId ?? null,
              usedKnowledge: Array.isArray(v.usedKnowledge) ? v.usedKnowledge : [],
            }))
          )
        })
        .catch(() => {})
    })
    return () => {
      cancelled = true
    }
    // work?.versionNumber：V2/V3 落盘后触发重拉；reloadTick：换个方向/再来一版重启时重拉
  }, [work?.projectId, work?.versionNumber, reloadTick])

  /**
   * 阶段 4：请求 AI 诊断。
   * @param generationId generation_history 行 id（项目版本用 versionId，老作品用本地 id）
   * @param force false=首次/重试（显示 loading 骨架）；true=已有诊断强制重测（保留旧卡）
   * 404/401 视为"该作品无云端行/未登录"，静默隐藏诊断区。
   */
  async function runDiagnosis(generationId: string, force: boolean) {
    if (force) setDiagnosisRefreshing(true)
    else setDiagnosisStatus('loading')
    setDiagnosisError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setDiagnosisStatus('hidden')
        return
      }
      const res = await fetch('/api/creative/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ generationId, force }),
      })
      const data = (await res.json().catch(() => null)) as
        | { analysis?: CreativeDiagnosis; error?: string }
        | null

      if (!res.ok || !data?.analysis) {
        if (res.status === 404 || res.status === 401) {
          setDiagnosisStatus('hidden')
        } else {
          setDiagnosisStatus('error')
          setDiagnosisError(data?.error ?? `诊断失败（${res.status}）`)
        }
        return
      }

      const analysis = parseDiagnosis(data.analysis)
      if (!analysis) {
        setDiagnosisStatus('error')
        setDiagnosisError('诊断结果解析失败')
        return
      }
      setDiagnosis(analysis)
      setDiagnosisStatus('done')
      // 回填本地作品，刷新页面直接展示，不重复消耗 LLM
      if (work) patchWork(work.id, { analysis })
    } catch {
      setDiagnosisStatus('error')
      setDiagnosisError('网络异常，请稍后重试')
    } finally {
      setDiagnosisRefreshing(false)
    }
  }

  /** 历史版本只读视图下手动补诊断（不自动批量刷旧版本，避免静默消耗 LLM 额度） */
  async function handleAnalyzeHistoryVersion(v: ProjectVersion) {
    if (historyDiagId) return
    setHistoryDiagId(v.id)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch('/api/creative/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ generationId: v.id, force: false }),
      })
      const data = (await res.json().catch(() => null)) as
        | { analysis?: CreativeDiagnosis }
        | null
      if (res.ok && data?.analysis) {
        const analysis = parseDiagnosis(data.analysis)
        if (analysis) {
          setVersions((vs) => vs.map((x) => (x.id === v.id ? { ...x, analysis } : x)))
        }
      }
    } catch {
      // 静默：按钮恢复可点即可
    } finally {
      setHistoryDiagId(null)
    }
  }

  // ── 阶段 4：最新版内容就绪后自动诊断（依赖 work.content：V1→V2 内容变化时重新触发）──
  useEffect(() => {
    if (!work || activeVersion !== null) return
    if (work.analysis) {
      setDiagnosis(work.analysis)
      setDiagnosisStatus('done')
      setDiagnosisError(null)
      return
    }
    let cancelled = false
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return
      if (!session?.access_token) {
        setDiagnosisStatus('hidden') // 游客：进化系统不可用，整块隐藏
        return
      }
      void runDiagnosis(work.versionId ?? work.id, false)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work?.id, work?.content, work?.analysis, activeVersion])

  /**
   * 阶段 5 / 第四阶段：点诊断方向卡（或自定义指令）→ 在同项目下定向生成下一版。
   * 复用当前文章 id（本地镜像覆盖为新版本，URL 不变），服务端从 fromVersionId 行继承参数。
   * sourceVersion 传入时 = 基于某个历史版本继续迭代（新版本仍线性追加到链尾，不覆盖任何版本）。
   */
  function handleImprove(
    direction: NextActionKey,
    instruction?: string,
    sourceVersion?: ProjectVersion
  ) {
    if (!work?.projectId || improvingDirection) return
    if (projectStatus === 'finalized') return
    const fromVersionId = sourceVersion?.id ?? work.versionId
    if (!fromVersionId) return
    if (direction === 'custom' && !instruction?.trim()) return
    setImprovingDirection(direction)
    // 记下验收基准：新版本落盘后要用「改动前的版本 + 用户原话」核对方向。
    // custom 且填了指令 → 用用户原话；否则用方向卡的中文文案，保证验收始终有据可依。
    const dirMeta = NEXT_ACTION_META.find((m) => m.key === direction)
    pendingAlignRef.current = {
      baseVersionId: fromVersionId,
      freeText:
        (direction === 'custom' ? instruction?.trim() : '') ||
        `${dirMeta?.label ?? direction}：${dirMeta?.blurb ?? ''}`,
      intentLabel: dirMeta?.label,
    }
    setFeedback(null)
    setActiveVersion(null) // 离开历史版本视图，进入生成中状态
    startGenerationTask(
      params.id,
      {
        // improve 模式服务端忽略以下表单字段，但类型要求必填，给安全占位
        topic: work.title,
        identityLabel: work.identityLabel ?? '通用解说者',
        style: work.style ?? '',
        wordCount: 300,
        category: '自定义类型',
        customCategory: work.category,
        projectId: work.projectId,
        // 阶段四：定向迭代从原作品快照带入角色，保证人设延续
        characters: work.characters ?? [],
        // Creator Mode：迭代沿用上一版模式，避免灵感作品突然个性化（模式精分）
        mode: work.mode,
        improve: {
          fromVersionId,
          direction,
          ...(direction === 'custom' ? { instruction: instruction!.trim() } : {}),
        },
        memory: buildMemorySummary(),
      },
      {
        title: work.title,
        identityLabel: work.identityLabel ?? '通用解说者',
        style: work.style ?? '',
        category: work.category,
      }
    )
    setBlueprint(null)
    setBlueprintExpanded(true)
    setPending(true)
    setReloadTick((t) => t + 1) // 重启轮询；落盘后 work.content 变化自动触发新版本诊断
  }

  /**
   * AI 协作修改（P4）：用户对补丁建议做决策。
   * 接受 → decide 端点服务端融合落库 → 本地镜像更新为新版本（触发版本列表重拉 + 重新诊断）
   * 拒绝 → 仅 decide 记编辑偏好，无版本变化
   * 任何失败抛错回面板展示（不静默）。
   */
  async function handlePatchDecision(
    accepted: boolean,
    patches: ModificationPatch[],
    summary: string,
    analysis: FeedbackAnalysis,
    freeText: string,
    // Work Agent：本次落版属于哪次共创讨论、用户当初选的哪个方案。
    // 缺了它，版本表里就只剩"改完了"，没有"为什么这么改"。
    extra?: { sessionId?: string | null; plan?: RevisionPlan | null }
  ) {
    if (!work?.versionId) throw new Error('缺少版本信息')
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) throw new Error('请先登录')
    const res = await fetch('/api/creative/patch/decide', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        generationId: work.versionId,
        accepted,
        patches,
        freeText,
        analysis,
        summary,
        sessionId: extra?.sessionId ?? null,
        plan: extra?.plan ?? null,
      }),
    })
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; accepted?: boolean; versionId?: string; versionNumber?: number; mergedContent?: string; error?: string }
      | null
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error ?? '处理失败，请重试')
    }
    if (!data.accepted) return // 拒绝：偏好已记录，无版本变化

    // 接受成功：本地镜像切到新版本（versionNumber 变化自动触发版本列表重拉）
    const nextNumber = typeof data.versionNumber === 'number' ? data.versionNumber : work.versionNumber
    patchWork(work.id, {
      content: data.mergedContent ?? work.content,
      versionId: data.versionId,
      versionNumber: nextNumber,
    })
    setWork((w) =>
      w
        ? {
            ...w,
            content: data.mergedContent ?? w.content,
            versionId: data.versionId,
            versionNumber: nextNumber,
          }
        : w
    )
    // 内容变了：旧诊断作废，重跑
    setDiagnosis(null)
    setDiagnosisError(null)
    setDiagnosisStatus('loading')
    if (data.versionId) void runDiagnosis(data.versionId, false)
    // 回传给共创面板：它要拿新版本 id 做方向验收（这次改动是否落在用户说的方向上）
    return data.versionId ?? ''
  }

  /**
   * 方向验收：定向迭代的新版本落盘后，核对它是否真的按用户反馈的方向改了。
   *
   * 之前这条链路是单向的——生成出来就默认"改好了"，用户只能自己通读全文
   * 才能发现"AI 根本没按我说的改"。这里补上闭环，结论交给共创面板展示。
   *
   * 失败一律静默：新版本已经落库，验收结论只是锦上添花，不能反过来打扰用户。
   */
  async function verifyImproveAlignment(
    versionId: string,
    base: { baseVersionId: string; freeText: string; intentLabel?: string }
  ) {
    if (!versionId || !base.freeText) return
    setAligning(true)
    setAlignment(null)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch('/api/creative/alignment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          generationId: versionId,
          baseVersionId: base.baseVersionId,
          freeText: base.freeText,
          intentLabel: base.intentLabel,
        }),
      })
      const data = (await res.json().catch(() => null)) as
        | { report?: AlignmentReport | null }
        | null
      setAlignment(data?.report ?? null)
    } catch {
      // 验收失败不阻塞：新版本本身已经生成成功
    } finally {
      setAligning(false)
    }
  }

  /**
   * 阶段 3 Work Agent：用户自由反馈确认后触发下一版生成。
   * 把 FeedbackAnalysis 格式化为优化指令注入 improve.instruction，
   * 与 handleImprove 走同一链路（服务端 /api/prompt-optimizer 会把 instruction 注入 user prompt）。
   *
   * 与 handleImprove 区别：
   *   - direction 来自 AI 分析（FeedbackAnalysis.intentType），而非用户点击预设按钮
   *   - instruction 是 formatFeedbackForPrompt 生成的完整优化蓝图（含用户反馈原文、
   *     修改点、优化蓝图），而不只是用户的一句话
   */
  function handleFeedbackConfirmed(analysis: FeedbackAnalysis, freeText: string) {
    if (!work?.projectId || improvingDirection) return
    if (projectStatus === 'finalized') return
    const fromVersionId = work.versionId
    if (!fromVersionId) return

    setImprovingDirection(analysis.intentType)
    setFeedback(null)
    setActiveVersion(null)

    // 把 FeedbackAnalysis 格式化为优化指令文本，注入 improve.instruction
    // 服务端 /api/prompt-optimizer 会把 instruction 作为"修改指令"注入 user prompt
    const instructionText = formatFeedbackForPrompt(analysis, freeText)

    startGenerationTask(
      params.id,
      {
        topic: work.title,
        identityLabel: work.identityLabel ?? '通用解说者',
        style: work.style ?? '',
        wordCount: 300,
        category: '自定义类型',
        customCategory: work.category,
        projectId: work.projectId,
        characters: work.characters ?? [],
        mode: work.mode,
        improve: {
          fromVersionId,
          direction: analysis.intentType,
          instruction: instructionText,
          userFeedback: freeText, // 阶段 4：用户原始反馈原文，落 generation_history.user_feedback
        },
        memory: buildMemorySummary(),
      },
      {
        title: work.title,
        identityLabel: work.identityLabel ?? '通用解说者',
        style: work.style ?? '',
        category: work.category,
      }
    )
    setBlueprint(null)
    setBlueprintExpanded(true)
    setPending(true)
    setReloadTick((t) => t + 1)
  }

  /** 阶段 5：定稿为最终作品 / 重新开启迭代 */
  async function handleToggleFinalize() {
    if (!work?.projectId || finalizeBusy) return
    setFinalizeBusy(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const next = projectStatus === 'finalized' ? 'active' : 'finalized'
      const res = await fetch(`/api/creative/projects/${encodeURIComponent(work.projectId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ status: next }),
      })
      if (res.ok) {
        setProjectStatus(next)
        // 刚定稿 = 用户刚认可作品，此刻是提示「让更多人看到」的最佳时机
        setJustFinalized(next === 'finalized')
      }
    } catch {
      // 静默：按钮恢复即可
    } finally {
      setFinalizeBusy(false)
    }
  }

  /**
   * 第三阶段：老作品「纳入持续创作」。
   * 用现有内容在云端建 creative_projects + V1 行；成功后回填本地归属，
   * 版本 tab/诊断/方向卡全部按既有链路自动激活，不需要任何老作品专属 UI 分支。
   */
  async function handleAdopt() {
    if (!work || adopting || work.projectId) return
    setAdopting(true)
    setAdoptError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setAdoptError('请先登录后再纳入持续创作')
        return
      }
      const res = await fetch('/api/creative/projects/adopt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          generationId: work.versionId ?? work.id,
          title: work.title,
          content: work.content,
          identityLabel: work.identityLabel ?? '',
          style: work.style ?? '',
          category: work.category,
          systemPrompt: work.systemPrompt ?? '',
        }),
      })
      const data = (await res.json().catch(() => null)) as
        | { projectId?: string; versionId?: string; versionNumber?: number; error?: string }
        | null
      const projectId = data?.projectId
      const versionId = data?.versionId
      if (!res.ok || !projectId || !versionId) {
        setAdoptError(data?.error ?? '纳入失败，请稍后重试')
        return
      }
      const adopted: GeneratedWork = {
        ...work,
        projectId,
        versionId,
        versionNumber: typeof data.versionNumber === 'number' ? data.versionNumber : 1,
      }
      setWork(adopted)
      patchWork(work.id, {
        projectId: adopted.projectId,
        versionId: adopted.versionId,
        versionNumber: adopted.versionNumber,
      })
      // 新 V1 行 feedback_status 必为 null：清掉旧散行对账来的反馈态，避免错位高亮
      setFeedback((f) => (f === 'like' || f === 'dislike' ? null : f))
      // V1 行刚建好：立即跑五维诊断（自动诊断 effect 只依赖 id/content，不会因 versionId 变更重跑）
      setDiagnosis(null)
      setDiagnosisError(null)
      setDiagnosisStatus('loading')
      void runDiagnosis(versionId, false)
      // 版本列表 effect 监听 work.projectId，会自动拉取 V1；无需手动刷新
    } catch {
      setAdoptError('网络异常，请稍后重试')
    } finally {
      setAdopting(false)
    }
  }

  // ── thinking 状态：数据就绪前，页面中间只展示思考动画 ──
  if (pending) {
    // 蓝图已就绪、V1 自动续写中：展示蓝图卡（用户可阅读，也可换个方向中断重构思）
    if (blueprint) {
      return (
        <div className="inner-page gen-stage px-6 py-16" data-mode="inspiration">
          <div className="max-w-2xl mx-auto">
            <div className="flex items-center gap-2 mb-6">
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-bounce [animation-delay:-0.3s]" />
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-bounce [animation-delay:-0.15s]" />
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-bounce" />
              <p className="ml-3 text-sm text-zinc-300">创作蓝图已就绪，AI 正在按此方向撰写 V1…</p>
            </div>

            <BlueprintCard bp={blueprint} />

            <div className="flex items-center justify-between mt-5">
              <p className="text-xs text-zinc-600">正文通常还需 10-15 秒，请勿刷新页面</p>
              <button
                onClick={handleReplan}
                className="text-xs text-zinc-400 hover:text-indigo-300 border border-zinc-800 hover:border-indigo-500/40 px-3 py-1.5 rounded-lg transition"
              >
                🔄 换个方向重新构思
              </button>
            </div>
          </div>
        </div>
      )
    }

    // 阶段 5：定向迭代进行中（无蓝图阶段，writing 态带 improveDirection）
    const currentTask = getTask(params.id)
    const improveMeta = currentTask?.improveDirection
      ? NEXT_ACTION_META.find((m) => m.key === currentTask.improveDirection)
      : null
    if (improveMeta) {
      return (
        <div className="inner-page gen-stage text-white flex flex-col items-center justify-center px-6" data-mode="inspiration">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-bounce [animation-delay:-0.3s]" />
            <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-bounce [animation-delay:-0.15s]" />
            <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-bounce" />
          </div>
          <p className="mt-6 text-sm text-zinc-200">
            {improveMeta.emoji} AI 正按「{improveMeta.label}」方向迭代下一版…
          </p>
          <p className="mt-2 text-xs text-zinc-500 max-w-sm text-center leading-relaxed">
            正在结合上一版诊断（优势 / 问题 / 建议）重写完整新版本，旧版本会原样保留
          </p>
          <p className="mt-2 text-xs text-zinc-600">通常需要 15-25 秒，请勿关闭或刷新页面</p>
        </div>
      )
    }

    // 无蓝图（蓝图构思中 / 游客单次生成）：沿用原思考动画
    return (
      <div className="inner-page gen-stage text-white flex flex-col items-center justify-center px-6" data-mode="inspiration">
        {/* 思考中的三点跳动动画 */}
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-bounce [animation-delay:-0.3s]" />
          <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-bounce [animation-delay:-0.15s]" />
          <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-bounce" />
        </div>
        <p className="mt-6 text-sm text-zinc-300">AI 正在构思方向并撰写文案…</p>
        <p className="mt-2 text-xs text-zinc-600">
          通常需要 10-20 秒，请勿关闭或刷新页面
        </p>
      </div>
    )
  }

  // ── 生成失败 / 链接无效：提供恢复表单与返回主页入口 ──
  if (error) {
    return (
      <div className="inner-page gen-stage text-white flex items-center justify-center px-6" data-mode="inspiration">
        <div className="text-center max-w-sm">
          <p className="text-sm text-red-400 leading-relaxed">{error}</p>
          <div className="flex items-center justify-center gap-3 mt-6">
            <button
              onClick={() => router.push('/generate?restore=1')}
              className="text-sm bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-lg transition"
            >
              返回修改表单
            </button>
            <Link
              href="/dashboard"
              className="text-sm bg-zinc-800 hover:bg-zinc-700 px-4 py-2 rounded-lg transition"
            >
              返回主页
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // ── 兜底：数据为空（正常流程不会走到）──
  if (!work) {
    return (
      <div className="inner-page gen-stage text-white flex items-center justify-center px-6" data-mode="inspiration">
        <div className="text-center">
          <p className="text-zinc-400 text-sm">文章不存在，或已被本地缓存清除</p>
          <Link
            href="/dashboard"
            className="inline-block mt-4 text-sm text-indigo-400 hover:underline"
          >
            返回主页
          </Link>
        </div>
      </div>
    )
  }

  // 阶段 4：创作参数改为 work_tags DNA + blueprint 摘要
  // 旧 identityLabel/style/category 在阶段 2 已清空落库，不再展示
  const paramCells: Array<[string, string]> = [
    ['作品类型', workTags?.work_type ?? blueprint?.content_type ?? '分析中'],
    ['主题', workTags?.theme ?? '分析中'],
    ['创作策略', blueprint?.usage_tag ?? '—'],
    ['生成日期', new Date(work.created_at).toLocaleDateString('zh-CN')],
  ]

  // ── 版本视图派生数据：activeVersion=null 时展示本地最新镜像，否则只读展示历史版本 ──
  const viewingVersion =
    activeVersion != null
      ? versions.find((v) => v.versionNumber === activeVersion) ?? null
      : null
  const displayContent = viewingVersion?.sampleText ?? work.content
  // 成品系统提示词不再对外展示（内部生成依据，不对用户暴露）
  const displayBlueprint = viewingVersion ? viewingVersion.blueprint : blueprint
  const latestVersionNumber = work.versionNumber ?? versions[versions.length - 1]?.versionNumber ?? null
  // 第四阶段：当前展示版本的"迭代元信息"（版本名/方向/时间/AI 修改说明）。
  // 历史版本取 versions 行；最新版优先取 DB 行（说明更全），本地镜像兜底。
  const displayVersionMeta: {
    versionNumber: number
    direction: NextActionKey | null
    note: string | null
    userFeedback: string | null
    createdAt: string | null
    editPatches: ModificationPatch[]
    revisePlan: RevisionPlan | null
  } | null = viewingVersion
    ? {
        versionNumber: viewingVersion.versionNumber,
        direction: viewingVersion.improveDirection,
        note: viewingVersion.improveNote,
        userFeedback: viewingVersion.userFeedback,
        createdAt: viewingVersion.createdAt,
        editPatches: viewingVersion.editPatches,
        revisePlan: viewingVersion.revisePlan,
      }
    : work.projectId && work.versionNumber
      ? (() => {
          const dbRow = versions.find((v) => v.versionNumber === work.versionNumber)
          return {
            versionNumber: work.versionNumber,
            direction: dbRow?.improveDirection ?? work.improveDirection ?? null,
            note: dbRow?.improveNote ?? work.improveNote ?? null,
            userFeedback: dbRow?.userFeedback ?? work.userFeedback ?? null,
            createdAt: dbRow?.createdAt ?? work.created_at ?? null,
            editPatches: dbRow?.editPatches ?? [],
            revisePlan: dbRow?.revisePlan ?? null,
          }
        })()
      : null
  // Creator Knowledge System Phase 3：当前正在看的这一版，当时是拿着哪几条知识写的。
  // 补的是完整性的一半——/generate 方案态的卡片只能看"这一次"，
  // 这里让用户回看任意历史版本时也能核对"AI 到底有没有用我的知识"。
  // 只认 versions 行的服务端数据：localStorage 镜像从不存知识依据，
  // 拿它兜底等于制造一个可信度为 0 的假来源。
  const displayKnowledge: InjectedUnitSummary[] =
    viewingVersion?.usedKnowledge ??
    (displayVersionMeta
      ? versions.find((v) => v.versionNumber === displayVersionMeta.versionNumber)
          ?.usedKnowledge
      : undefined) ??
    []

  // 分享弹窗里"灵感起点"的预填文案：优先用蓝图的主题定位/核心冲突
  const shareDefaultInspiration = (() => {
    const seed = blueprint?.positioning || blueprint?.core_conflict
    if (seed) return `最初想探讨的是：${seed}`
    return work.title ? `关于「${work.title}」的一次创作——` : ''
  })()
  return (
    <PageShell width="narrow">
      {/* 从素材库进入（有记忆）→ back 触发 popstate 恢复列表位置；生成页进入/直访 → push 主页 */}
      <button
        type="button"
        onClick={() => backToDashboard(router)}
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-zinc-500 transition hover:text-zinc-200"
      >
        ← 返回主页
      </button>

      {/* 页面理念：这是作品成长空间，不是文章查看器 */}
      <PageHeader
        eyebrow="持续创作空间"
        title={work.title}
        description="这是你和 AI 共同完成的作品。AI 会先读懂它，再和你一起改——你说哪里不对，它先确认你的意思，再动手。"
        ai={
          <AiStatus
            task="diagnose"
            active={diagnosisStatus === 'loading' || diagnosisRefreshing}
            variant="bar"
          />
        }
      />

      {/* 阶段 4：创作参数改为 work_tags DNA + blueprint 摘要 */}
      <StatRow
        className="mb-2"
        items={paramCells.map(([label, value]) => ({ label, value }))}
      />

        {/* 阶段四：登场角色快照（本篇生成时锁定的设定，悬停可看详情） */}
        {work.characters && work.characters.length > 0 && (
          <div className="flex items-center flex-wrap gap-2 mt-4">
            <span className="text-xs text-zinc-500 mr-1">登场角色</span>
            {work.characters.map((c) => {
              const detail = [
                CHARACTER_ROLE_LABELS[c.role],
                c.isSelf ? '用户本人（AI 不虚构其真实经历）' : '',
                c.background ? `背景：${c.background}` : '',
                c.personality ? `性格：${c.personality}` : '',
              ]
                .filter(Boolean)
                .join('\n')
              return (
                <span
                  key={c.name}
                  title={detail}
                  className="inline-flex items-center gap-1.5 text-xs text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-full px-3 py-1"
                >
                  {c.name}
                  {c.isSelf && <span className="text-[10px] text-emerald-400">我</span>}
                </span>
              )
            })}
          </div>
        )}

        {/* 创作进化系统阶段 3：版本切换 tab（仅项目作品；V2 生成后可回看 V1） */}
        {work.projectId && versions.length > 0 && (
          <div className="flex items-center flex-wrap gap-2 mt-6">
            <span className="text-xs text-zinc-500 mr-1">版本</span>
            {versions.map((v) => {
              const isActive =
                activeVersion === v.versionNumber ||
                (activeVersion === null && v.versionNumber === latestVersionNumber)
              const isLatest = v.versionNumber === latestVersionNumber
              return (
                <button
                  key={v.id}
                  onClick={() => setActiveVersion(isLatest ? null : v.versionNumber)}
                  title={`${new Date(v.createdAt).toLocaleString('zh-CN')}${
                    v.improveDirection
                      ? ` · 按「${NEXT_ACTION_META.find((m) => m.key === v.improveDirection)?.label ?? v.improveDirection}」迭代`
                      : ' · 初稿'
                  }`}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition border ${
                    isActive
                      ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/50'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:border-zinc-600 hover:text-zinc-200'
                  }`}
                >
                  V{v.versionNumber}
                  {v.improveDirection && (
                    <span
                      className="ml-1"
                      title={`按「${NEXT_ACTION_META.find((m) => m.key === v.improveDirection)?.label ?? v.improveDirection}」方向迭代`}
                    >
                      {NEXT_ACTION_META.find((m) => m.key === v.improveDirection)?.emoji ?? '↻'}
                    </span>
                  )}
                  {isLatest && <span className="ml-1 text-[10px] text-indigo-400/80">最新</span>}
                </button>
              )
            })}
            {/* 发布到灵感广场（仅最新版视图；档案快照由服务端构建）
                定稿后升级为主按钮：用户已认可作品，发布就是最自然的下一步。
                注意：ml-auto 只放在外层容器上——原先发布按钮与定稿按钮各带一个
                ml-auto，两个 auto 外边距互相抢空间，导致排版错乱。 */}
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => setShareOpen(true)}
                title="把灵感、创作过程与最终作品分享到灵感广场"
                className={
                  projectStatus === 'finalized'
                    ? 'text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 border border-indigo-500 rounded-lg px-3 py-1.5 transition'
                    : 'text-xs text-zinc-400 hover:text-indigo-300 border border-zinc-800 hover:border-indigo-500/40 rounded-lg px-3 py-1.5 transition'
                }
              >
                📢 发布到灵感广场
              </button>
              {/* 阶段 5：定稿为最终作品 / 已定稿徽标 */}
              {projectStatus === 'finalized' ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-1.5">
                  ✓ 最终作品 V{latestVersionNumber ?? '?'}
                </span>
              ) : (
                <button
                  onClick={handleToggleFinalize}
                  disabled={finalizeBusy || !diagnosis}
                  title={!diagnosis ? 'AI 诊断完成后即可定稿' : '把当前最新版本确定为最终作品'}
                  className="text-xs text-zinc-400 hover:text-emerald-300 border border-zinc-800 hover:border-emerald-500/40 rounded-lg px-3 py-1.5 transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {finalizeBusy ? '处理中…' : '✓ 定为最终作品'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* 定稿后的发布引导 —— 补齐「定稿 → 发布」这一环。
            实测定稿→发布转化长期为 0%：定稿成功后页面只换了个徽标、没有任何引导，
            而用户此刻恰恰刚完成「我认可这个作品」的心理动作，是最该被提示的时机。
            给一个明确的下一步，但不强制（可「暂不」关掉）。 */}
        {justFinalized && projectStatus === 'finalized' && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-3">
            <p className="min-w-[12rem] flex-1 text-[13px] leading-relaxed text-zinc-300">
              ✅ 已定为最终作品。要让它被更多人看到吗？
            </p>
            <button
              onClick={() => {
                setShareOpen(true)
                setJustFinalized(false)
              }}
              className="text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg px-3.5 py-1.5 transition"
            >
              📢 发布到灵感广场
            </button>
            <button
              onClick={() => setJustFinalized(false)}
              className="text-xs text-zinc-400 hover:text-zinc-200 transition"
            >
              暂不
            </button>
          </div>
        )}

        {/* 第四阶段：版本元信息条——版本名 / 生成时间 / 本次优化方向 / AI 为什么这样修改 */}
        {displayVersionMeta && (displayVersionMeta.direction || displayVersionMeta.note || displayVersionMeta.userFeedback) && (
          <div className="mt-3 rounded-lg border border-zinc-800/80 bg-zinc-900/50 px-4 py-3">
            <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-[11px]">
              <span className="text-zinc-300 font-medium">
                V{displayVersionMeta.versionNumber}
                {displayVersionMeta.direction
                  ? ` · ${NEXT_ACTION_META.find((m) => m.key === displayVersionMeta.direction)?.emoji ?? '↻'} ${
                      NEXT_ACTION_META.find((m) => m.key === displayVersionMeta.direction)?.label ??
                      displayVersionMeta.direction
                    }迭代版`
                  : ' · 初稿'}
              </span>
              {displayVersionMeta.createdAt && (
                <span className="text-zinc-600">
                  {new Date(displayVersionMeta.createdAt).toLocaleString('zh-CN', {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              )}
            </div>
            {displayVersionMeta.userFeedback && (
              <p className="mt-1.5 text-xs text-zinc-400 leading-relaxed">
                <span className="text-amber-400/90">💬 你的反馈：</span>
                {displayVersionMeta.userFeedback}
              </p>
            )}
            {displayVersionMeta.note && (
              <p className="mt-1.5 text-xs text-zinc-400 leading-relaxed">
                <span className="text-indigo-400/90">🤖 AI 修改说明：</span>
                {displayVersionMeta.note}
              </p>
            )}

            {/* ── Work Agent 版本记录：这一版到底改了哪几段、用的哪个方案 ──
                没有这段，版本列表只是"V1/V2/V3 三个按钮"，用户看不到局部修改的边界，
                也就没法判断 AI 有没有越界改了他不想动的地方。 */}
            {displayVersionMeta.editPatches.length > 0 && (
              <details className="mt-2 group">
                <summary className="text-[11px] text-zinc-500 cursor-pointer select-none hover:text-zinc-300">
                  ✏️ 本版改动 {displayVersionMeta.editPatches.length} 处
                  {displayVersionMeta.revisePlan && (
                    <span className="ml-1.5 text-zinc-600">
                      · 方案「{displayVersionMeta.revisePlan.title}」
                    </span>
                  )}
                  <span className="ml-1.5 text-zinc-600">（点击查看明细）</span>
                </summary>
                {displayVersionMeta.revisePlan && (
                  <p className="mt-1.5 text-[11px] text-zinc-500 leading-relaxed">
                    承诺保持不变：{displayVersionMeta.revisePlan.preserveItems.join('、')}
                  </p>
                )}
                <div className="mt-2 space-y-2">
                  {displayVersionMeta.editPatches.map((p, i) => (
                    <div
                      key={`${p.segmentIndex}-${i}`}
                      className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2"
                    >
                      <p className="text-[10px] text-zinc-500 mb-1.5">
                        第 {p.segmentIndex} 段 · {p.reason}
                      </p>
                      <p className="text-[11px] text-zinc-600 leading-relaxed line-through decoration-zinc-700">
                        {p.originalExcerpt.slice(0, 200)}
                      </p>
                      <p className="text-[11px] text-zinc-300 leading-relaxed mt-1">
                        {p.revisedText.slice(0, 400)}
                      </p>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {/* 创作蓝图（当前查看版本的蓝图；完成后默认收起，点击回看 AI 构思方向） */}
        {displayBlueprint && (
          <div className="mt-8">
            <button
              onClick={() => setBlueprintExpanded((v) => !v)}
              className="w-full flex items-center justify-between bg-zinc-900/60 border border-indigo-500/20 rounded-xl px-5 py-3 text-sm text-zinc-300 hover:border-indigo-500/40 transition"
            >
              <span className="flex items-center gap-2">
                <span>🧭</span>
                <span className="font-medium">创作蓝图</span>
                <span className="text-xs text-zinc-500">
                  {viewingVersion ? `V${viewingVersion.versionNumber} 按此方向生成` : '本篇按此方向生成'}
                </span>
              </span>
              <span className={`text-xs text-zinc-500 transition-transform ${blueprintExpanded ? 'rotate-180' : ''}`}>
                ▾
              </span>
            </button>
            {blueprintExpanded && (
              <div className="mt-3">
                <BlueprintCard bp={displayBlueprint} />
              </div>
            )}
          </div>
        )}

        {/* 历史版本查看提示条：内容只读，但可直接基于本版选择方向继续迭代（新版本追加到链尾） */}
        {viewingVersion && (
          <div className="mt-8 flex items-center justify-between gap-4 bg-zinc-900/70 border border-zinc-700/60 rounded-xl px-5 py-3">
            <p className="text-xs text-zinc-400">
              正在查看历史版本 <span className="text-zinc-200 font-medium">V{viewingVersion.versionNumber}</span>
              。原文为只读；在下方选择方向即可
              <span className="text-indigo-300">基于 V{viewingVersion.versionNumber} 继续迭代</span>
              ，新版本将追加为 V{latestVersionNumber ? latestVersionNumber + 1 : '?'}，不会覆盖任何版本。
            </p>
            <button
              onClick={() => setActiveVersion(null)}
              className="shrink-0 text-xs bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded-lg transition"
            >
              返回最新版 V{latestVersionNumber}
            </button>
          </div>
        )}

        {/* ── 阶段 5：本次生成参考（Creator Profile + Knowledge Base + 声明约束）── */}
        {activeVersion === null && (
          (work.personalization || (work.declarationTraits && work.declarationTraits.length > 0)) && (
            <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[10px] font-medium text-amber-400 tracking-wide uppercase">
                  本次生成参考
                </span>
              </div>
              {/* Creator Profile + 素材库参考 */}
              {work.personalization && (
                <PersonalizationNote evidence={work.personalization} />
              )}
              {/* Creator Declaration 约束 */}
              {work.declarationTraits && work.declarationTraits.length > 0 && (
                <div className={`flex flex-wrap items-center gap-2 ${work.personalization ? 'mt-3 pt-3 border-t border-zinc-800/60' : ''}`}>
                  <span className="text-[11px] text-zinc-500 leading-relaxed">
                    创作者声明：
                  </span>
                  {work.declarationTraits.map((t, idx) => (
                    <span
                      key={idx}
                      className={`text-[11px] px-2 py-0.5 rounded-full border ${
                        t.hard
                          ? 'border-red-500/30 bg-red-500/10 text-red-300'
                          : 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300'
                      }`}
                      title={t.hard ? '硬约束' : '软约束'}
                    >
                      {t.dimension}：{t.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        )}

        {/* ── Creator Knowledge System Phase 3：这一版当时依据了哪些已确认知识 ──
            刻意紧跟"本次生成参考"：用户核对 AI 有没有用他的知识，
            就该在"这次参考了什么"同一个位置看到，而不是散落在页面别处。
            空数组不渲染 —— 没参考就是没参考，不画空壳卡片。 */}
        {displayKnowledge.length > 0 && (
          <div className="mt-3 rounded-xl border border-violet-500/25 bg-violet-500/5 px-5 py-4">
            <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
              <span className="text-[10px] font-medium text-violet-300 tracking-wide uppercase">
                {activeVersion !== null
                  ? `V${activeVersion} 参考了你的 ${displayKnowledge.length} 条知识`
                  : `本次参考了你的 ${displayKnowledge.length} 条知识`}
              </span>
              <Link
                href="/knowledge"
                className="text-[10px] text-zinc-500 hover:text-violet-300 transition"
              >
                去管理 →
              </Link>
            </div>
            <ul className="space-y-2.5">
              {displayKnowledge.map((u, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="shrink-0 mt-1.5 w-1 h-1 rounded-full bg-violet-400/70" />
                  <div className="min-w-0">
                    <span className="text-xs text-violet-200/90">{u.concept}</span>
                    {u.kind && <span className="ml-1.5 text-[10px] text-zinc-500">{u.kind}</span>}
                    <p className="text-xs text-zinc-300 leading-relaxed mt-0.5">{u.claim}</p>
                  </div>
                </li>
              ))}
            </ul>
            {activeVersion !== null && (
              <p className="mt-3 text-[10px] text-zinc-600 leading-relaxed">
                这是该版本生成当时的记录，与你现在的知识库可能已有出入
              </p>
            )}
          </div>
        )}

        <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl mt-6 overflow-hidden">
          <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-200">
              解说范文
            </h2>
            <button
              onClick={() => handleCopy(displayContent)}
              className="text-xs bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded transition"
            >
              {copied === 'sample' ? '已复制' : '复制'}
            </button>
          </div>
          <p className="px-6 py-5 text-sm text-zinc-300 whitespace-pre-wrap break-words leading-relaxed">
            {displayContent}
          </p>
        </div>

        {/* ── 阶段 5 + 阶段 4：作品标签分析（9 维度结构化标签，异步加载，游客也可见）── */}
        {workTagsStatus !== 'error' && (
          <div className="mt-8">
            {workTagsStatus === 'loading' && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-4 flex items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                <p className="text-xs text-zinc-500">AI 正在分析作品标签…</p>
              </div>
            )}
            {workTags && workTagsStatus === 'done' && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[10px] font-medium text-indigo-400 tracking-wide uppercase">
                    作品 DNA
                  </span>
                </div>

                {/* 6 枚举维度 DNA（与 KnowledgeItem 完全对齐，作品/素材同构） */}
                <div className="space-y-2 mb-3">
                  {/* 内容 */}
                  {workTags.content_tags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-zinc-500 w-10 shrink-0">内容</span>
                      {workTags.content_tags.map((t) => (
                        <span key={t} className="rounded-full border border-blue-700/40 bg-blue-900/20 px-2 py-0.5 text-[11px] text-blue-300">{t}</span>
                      ))}
                    </div>
                  )}
                  {/* 思想 */}
                  {workTags.thought_tags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-zinc-500 w-10 shrink-0">思想</span>
                      {workTags.thought_tags.map((t) => (
                        <span key={t} className="rounded-full border border-indigo-700/40 bg-indigo-900/20 px-2 py-0.5 text-[11px] text-indigo-300">{t}</span>
                      ))}
                    </div>
                  )}
                  {/* 情绪 */}
                  {workTags.emotion_tags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-zinc-500 w-10 shrink-0">情绪</span>
                      {workTags.emotion_tags.map((t) => (
                        <span key={t} className="rounded-full border border-rose-700/40 bg-rose-900/20 px-2 py-0.5 text-[11px] text-rose-300">{t}</span>
                      ))}
                    </div>
                  )}
                  {/* 表达 */}
                  {workTags.expression_tags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-zinc-500 w-10 shrink-0">表达</span>
                      {workTags.expression_tags.map((t) => (
                        <span key={t} className="rounded-full border border-amber-700/40 bg-amber-900/20 px-2 py-0.5 text-[11px] text-amber-300">{t}</span>
                      ))}
                    </div>
                  )}
                  {/* 用途 */}
                  {workTags.usage_tags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-zinc-500 w-10 shrink-0">用途</span>
                      {workTags.usage_tags.map((t) => (
                        <span key={t} className="rounded-full border border-emerald-700/40 bg-emerald-900/20 px-2 py-0.5 text-[11px] text-emerald-300">{t}</span>
                      ))}
                    </div>
                  )}
                  {/* 受众 */}
                  {workTags.audience_tags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-zinc-500 w-10 shrink-0">受众</span>
                      {workTags.audience_tags.map((t) => (
                        <span key={t} className="rounded-full border border-purple-700/40 bg-purple-900/20 px-2 py-0.5 text-[11px] text-purple-300">{t}</span>
                      ))}
                    </div>
                  )}
                </div>

                {/* 7 自由文本描述维度 */}
                <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-800/60 mb-2">
                  {[
                    { label: '类型', value: workTags.work_type },
                    { label: '主题', value: workTags.theme },
                    { label: '表达', value: workTags.expression_style },
                    { label: '情绪', value: workTags.emotion },
                    { label: '受众', value: workTags.audience },
                    { label: '结构', value: workTags.narrative_structure },
                  ].filter((t) => t.value).map((t) => (
                    <span
                      key={t.label}
                      className="rounded-full border border-zinc-700 bg-zinc-800/60 px-3 py-1 text-xs text-zinc-300"
                    >
                      <span className="text-zinc-500 mr-1">{t.label}:</span>
                      {t.value}
                    </span>
                  ))}
                </div>

                {workTags.core_viewpoint && (
                  <p className="text-xs text-zinc-400 leading-relaxed pt-1">
                    <span className="text-zinc-500">核心观点：</span>
                    {workTags.core_viewpoint}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── AI 作品诊断（表现良好 / 需要改进 两段）── */}
        <div className="mt-8">
          {viewingVersion ? (
            // 历史版本：展示该版本自己的诊断；从未诊断过时给手动入口（不自动批量消耗额度）
            viewingVersion.analysis ? (
              <DiagnosisCard diagnosis={viewingVersion.analysis} />
            ) : (
              <button
                onClick={() => handleAnalyzeHistoryVersion(viewingVersion)}
                disabled={historyDiagId === viewingVersion.id}
                className="w-full bg-zinc-900/60 border border-dashed border-zinc-700 rounded-xl px-5 py-4 text-xs text-zinc-500 hover:border-indigo-500/40 hover:text-zinc-300 disabled:opacity-50 transition"
              >
                {historyDiagId === viewingVersion.id
                  ? '🧪 正在诊断 V' + viewingVersion.versionNumber + '…'
                  : `🧪 为历史版本 V${viewingVersion.versionNumber} 生成 AI 诊断`}
              </button>
            )
          ) : (
            // 最新版：生成完成后自动诊断；hidden = 游客/无云端行，整块不渲染
            diagnosisStatus !== 'hidden' &&
            diagnosisStatus !== 'idle' && (
              <>
                {/* 定稿项目：诊断卡上方显示最终作品状态 + 重新开启入口 */}
                {work.projectId && projectStatus === 'finalized' && (
                  <div className="mb-3 flex items-center justify-between gap-4 bg-emerald-500/10 border border-emerald-500/25 rounded-xl px-5 py-3">
                    <p className="text-xs text-emerald-300">
                      ✓ 已定为最终作品（V{latestVersionNumber ?? '?'}）。该项目的版本链已完整保留。
                    </p>
                    <button
                      onClick={handleToggleFinalize}
                      disabled={finalizeBusy}
                      className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 hover:border-zinc-500 px-3 py-1.5 rounded-lg transition disabled:opacity-40"
                    >
                      重新开启迭代
                    </button>
                  </div>
                )}
                <DiagnosisCard
                  diagnosis={diagnosis ?? undefined}
                  loading={diagnosisStatus === 'loading'}
                  error={diagnosisStatus === 'error' ? diagnosisError : null}
                  onRetry={() => work && runDiagnosis(work.versionId ?? work.id, false)}
                  onRefresh={() => work && runDiagnosis(work.versionId ?? work.id, true)}
                  refreshing={diagnosisRefreshing}
                />
                {diagnosisRefreshing && diagnosis && (
                  <p className="text-[11px] text-zinc-600 mt-2">正在重新诊断，当前展示的是上一次结果…</p>
                )}
              </>
            )
          )}
        </div>

        {/* ── 继续优化这一版（替换原"下一步可以这样做"方向卡）──
            自由反馈 → AI 分析 → 用户确认 → 生成下一版；快捷方向直接触发
            这是作品页的协作主入口：AI 不是按钮，而是带着上下文的编辑伙伴 */}
        {work.projectId && !viewingVersion && (
          <>
            <div className="mb-3 mt-12">
              <h2 className="text-[17px] sm:text-lg font-semibold tracking-tight text-zinc-100">
                和 AI 一起改这一版
              </h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-500">
                直接说你的感觉，比如「这里太平淡」。AI 会先确认你指的是什么、再给出改法，不会擅自重写。
              </p>
            </div>
            <WorkAgentChat
            currentContent={work.content}
            topic={work.title}
            generationId={work.versionId}
            diagnosis={diagnosis}
            isLoggedIn={!!work.projectId} // 项目作品必然来自登录用户
            projectId={work.projectId}
            finalized={projectStatus === 'finalized'}
            improvingDirection={improvingDirection}
            onQuickDirection={(d, instruction) =>
              handleImprove(d as NextActionKey, instruction)
            }
            onFeedbackConfirmed={handleFeedbackConfirmed}
            onPatchDecision={handlePatchDecision}
            alignmentReport={alignment}
            aligning={aligning}
            />
          </>
        )}

        {/* ── 发布表现回流（闭环最后一环）：站内 👍/👎 记录生成质量，
            这里记录发布到平台后的真实市场表现，两者是不同的信号 ── */}
        {!viewingVersion && (
          <PerformanceCard generationId={work.versionId ?? work.id} />
        )}

        {/* 第三阶段：老作品纳入持续创作入口（无项目归属的最新版才显示；
            纳入后版本 tab / 五维诊断 / 方向迭代 / 定稿全部自动激活） */}
        {!viewingVersion && !work.projectId && (
          <div className="mt-8 rounded-xl border border-indigo-500/25 bg-gradient-to-br from-indigo-500/10 to-purple-500/5 px-6 py-5">
            <div className="flex items-start justify-between gap-5 flex-wrap">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  <span>🧭</span> 把这篇作品纳入持续创作
                </h2>
                <p className="mt-1.5 text-xs text-zinc-400 leading-relaxed">
                  建立 V1 版本档案后开放：AI 五维诊断、按方向迭代 V2/V3、版本对比与最终定稿。当前内容原样保留为第一版。
                </p>
                {adoptError && <p className="mt-2 text-xs text-red-400">{adoptError}</p>}
              </div>
              <button
                onClick={handleAdopt}
                disabled={adopting}
                className="shrink-0 px-5 py-2.5 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-wait transition"
              >
                {adopting ? '纳入中…' : '纳入持续创作'}
              </button>
            </div>
          </div>
        )}

        {/* 历史版本只读：不展示反馈/编辑/迭代操作，仅保留返回最新版入口 */}
        {!viewingVersion && (
        <>
        {/* 底部操作：收藏至灵感库 + 再次生成同款风格 */}
        <div className="flex flex-wrap gap-4 mt-8">
          <button
            onClick={handleFavorite}
            className={`px-6 py-3 rounded-xl font-medium text-sm transition border ${
              favorited
                ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                : 'bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800 hover:border-zinc-600'
            }`}
          >
            {favorited ? '★ 已收藏至灵感库' : '☆ 收藏至灵感库'}
          </button>
          <button
            onClick={handleRegenerate}
            className="px-6 py-3 rounded-xl font-medium text-sm bg-indigo-600 hover:bg-indigo-500 transition"
          >
            ↻ 再次生成同款风格
          </button>
        </div>

        {/* ── 反馈区：四个按钮 ── */}
        <div className="mt-10 pt-8 border-t border-zinc-800/80">
          <p className="text-sm text-zinc-400 mb-4">这次生成结果怎么样？</p>
          <div className="flex flex-wrap gap-3">
            {/* 🔁 乐观更新：点击瞬间变色；只有「自己的请求」在飞时才锁定并显示转圈，
                不用全局遮罩/整体变灰，避免"点了没反应"的延迟感 */}
            <button
              onClick={() => handleFeedback('like')}
              disabled={feedbackPending === 'like'}
              className={`px-5 py-2.5 rounded-xl text-sm font-medium transition border disabled:cursor-wait ${
                feedback === 'like'
                  ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800'
              }`}
            >
              👍 很像
              {feedbackPending === 'like' && (
                <span className="ml-1.5 inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin align-[-1px]" />
              )}
            </button>
            <button
              onClick={() => handleFeedback('dislike')}
              disabled={feedbackPending === 'dislike'}
              className={`px-5 py-2.5 rounded-xl text-sm font-medium transition border disabled:cursor-wait ${
                feedback === 'dislike'
                  ? 'bg-red-500/15 text-red-400 border-red-500/40'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800'
              }`}
            >
              👎 差点意思
              {feedbackPending === 'dislike' && (
                <span className="ml-1.5 inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin align-[-1px]" />
              )}
            </button>
            <button
              onClick={handleEditStart}
              disabled={feedbackPending !== null}
              className={`px-5 py-2.5 rounded-xl text-sm font-medium transition border disabled:opacity-40 disabled:cursor-not-allowed ${
                feedback === 'edit' && editMode
                  ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/40'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800'
              }`}
            >
              ✏️ 我改改
            </button>
            <button
              onClick={handleRegenerateFeedback}
              disabled={regenerating || feedbackPending !== null}
              className={`px-5 py-2.5 rounded-xl text-sm font-medium transition border disabled:opacity-40 disabled:cursor-not-allowed ${
                feedback === 'regenerate'
                  ? 'bg-purple-500/15 text-purple-400 border-purple-500/40'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800'
              }`}
            >
              {regenerating ? '重新生成中…' : '🔄 再来一版'}
            </button>
          </div>

          {/* 反馈失败提示（成功状态的变化已随按钮高亮体现） */}
          {feedbackError && (
            <p className="text-xs text-red-400 mt-3">{feedbackError}</p>
          )}

          {/* 编辑模式：展开 textarea + 保存按钮。
              dark-scroll = 深色细滚动条 + 内部滚动不连锁页面；max-h 限定拖拽上限不超过视口 */}
          {editMode && (
            <div className="mt-4">
              <textarea
                value={editedText}
                onChange={(e) => setEditedText(e.target.value)}
                rows={12}
                className="dark-scroll w-full max-h-[60vh] overflow-y-auto bg-zinc-900 border border-zinc-800 rounded-xl px-5 py-4 text-sm text-zinc-300 leading-relaxed focus:border-indigo-500 focus:outline-none transition resize-y"
                placeholder="在这里修改文案…"
              />
              <div className="flex gap-3 mt-3">
                <button
                  onClick={handleEditSave}
                  disabled={savingEdit || !editedText.trim()}
                  className="px-5 py-2.5 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 transition"
                >
                  {savingEdit ? '保存中…' : '保存修改'}
                </button>
                <button
                  onClick={() => { setEditMode(false); setFeedback(null) }}
                  className="px-5 py-2.5 rounded-xl text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 反馈提示 */}
          {feedback && !editMode && feedback !== 'regenerate' && (
            <p className="text-xs text-zinc-500 mt-3">
              {feedback === 'like' && '感谢反馈！已记录为"很像"'}
              {feedback === 'dislike' && '感谢反馈！已记录为"差点意思"'}
              {feedback === 'edit' && '已保存修改内容'}
            </p>
          )}
        </div>
        </>
        )}

        <p className="text-xs text-zinc-600 mt-6">
          {work.projectId
            ? '该作品属于创作项目，V1/V2/V3 历史版本已保存在云端'
            : '文章保存在浏览器本地，清除缓存后将无法通过此链接访问'}
        </p>

      {/* 作品 → 灵感广场分享（仅项目作品可触发；项目 id 与版本数来自已加载数据） */}
      {work.projectId && (
        <ShareToPlazaModal
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          projectId={work.projectId}
          title={work.title}
          versionCount={versions.length || work.versionNumber || 1}
          defaultInspiration={shareDefaultInspiration}
        />
      )}
    </PageShell>
  )
}

// ────────────────────────────────────────────────────────────
// 个人化证据行：展示本次生成实际用到了哪些用户数据层。
// 只呈现"证据"（层名称 + 条数），不展示任何内部 prompt 文本。
// ────────────────────────────────────────────────────────────
function PersonalizationNote({
  evidence,
}: {
  evidence: import('@/lib/creative/creatorModel').PersonalizationEvidence
}) {
  // 关闭状态
  if (!evidence.enabled) {
    return (
      <div className="mt-6 flex items-start gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">
        <span className="text-sm leading-none">🔕</span>
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          本次按通用风格生成，未参考你的创作者人格、风格画像与素材库
        </p>
      </div>
    )
  }

  // 开启但尚无可用个人数据（新用户/人格与画像为空）
  if (evidence.layers.length === 0) {
    return (
      <div className="mt-6 flex items-start gap-2 rounded-xl border border-indigo-500/20 bg-indigo-500/5 px-4 py-3">
        <span className="text-sm leading-none">✨</span>
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          已开启创作者人格——你的风格数据还在积累中。多创作、多给反馈、在风格卡设置人格后，
          AI 会越来越像"懂你的专属创作伙伴"
        </p>
      </div>
    )
  }

  // 把层标签加上具体数量
  const rendered = evidence.layers.map((layer) => {
    if (layer === '素材库相关参考') return `素材库相关参考 ×${evidence.materialCount}`
    if (layer === '五维风格画像' && evidence.dimensionSamples > 0)
      return `五维风格画像（${evidence.dimensionSamples} 条行为样本）`
    return layer
  })

  // 第七阶段：本次实际采用的创作者特征（全部为真实统计：向量一致度 + DNA 历史占比）
  const traits = evidence.traits ?? []
  const styleMatchPct =
    typeof evidence.styleMatch === 'number' ? Math.round(evidence.styleMatch * 100) : null

  return (
    <div className="mt-6 rounded-xl border border-indigo-500/20 bg-indigo-500/5 px-4 py-3">
      <div className="flex items-start gap-2">
        <span className="text-sm leading-none">✨</span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-indigo-200/90 leading-relaxed">
            本次作品采用了你的创作特征
          </p>

          {(styleMatchPct !== null || traits.length > 0) && (
            <div className="mt-1.5 space-y-0.5">
              {styleMatchPct !== null && (
                <p className="text-[11px] text-zinc-300 leading-relaxed">
                  语言风格一致度{' '}
                  <span className="text-indigo-300 font-medium">{styleMatchPct}%</span>
                  <span className="text-zinc-500">（与你历史作品向量比对）</span>
                </p>
              )}
              {traits.map((t) => (
                <p key={t.dimension} className="text-[11px] text-zinc-300 leading-relaxed">
                  {t.dimension}：<span className="text-indigo-300 font-medium">{t.label}</span>
                  {typeof t.ratio === 'number' && (
                    <span className="text-zinc-500">
                      （占你历史样本 {Math.round(t.ratio * 100)}%）
                    </span>
                  )}
                </p>
              ))}
            </div>
          )}

          <p className="text-[11px] text-indigo-200/80 leading-relaxed mt-1.5">
            参考数据：<span className="text-zinc-300">{rendered.join(' · ')}</span>
          </p>
        </div>
      </div>
    </div>
  )
}
