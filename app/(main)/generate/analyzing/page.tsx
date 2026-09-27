'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useCreationFlow } from '@/components/generate/creation-flow-provider'
import styles from '../creation-flow.module.css'

const PLAN_STEPS = [
  '正在理解你的想法',
  '正在分析创作方向',
  '正在匹配你的知识与素材',
  '正在形成创作策略',
]

const INSPIRATION_STEPS = [
  '判断是否具有创作空间',
  '寻找可以成立的独特角度',
  '评估是否符合当前创作者',
  '判断这个灵感是否值得继续',
]

export default function CreationAnalyzingPage() {
  const router = useRouter()
  const {
    flow,
    hydrated,
    account,
    analysisStep,
    hasResult,
    runPendingAnalysis,
    retryAnalysis,
    cancelAnalysis,
  } = useCreationFlow()

  const inspirationTask = flow.analysisTask === 'inspiration'
  const steps = inspirationTask ? INSPIRATION_STEPS : PLAN_STEPS
  const title = inspirationTask ? '正在判断这个想法' : '正在理解你的创作'
  const aside = inspirationTask
    ? '视界正在判断它有没有值得继续的空间。'
    : '视界正在把你的想法整理成可以确认的创作方向。'

  useEffect(() => {
    if (!hydrated || !account.authReady) return
    if (hasResult && flow.analysisStatus === 'idle') {
      router.replace('/generate/result')
      return
    }
    if (flow.analysisStatus === 'queued') {
      void runPendingAnalysis()
    }
  }, [
    account.authReady,
    flow.analysisStatus,
    hasResult,
    hydrated,
    router,
    runPendingAnalysis,
  ])

  if (!hydrated) {
    return (
      <main className={styles.page}>
        <div className={styles.loadingState}>正在进入创作空间</div>
      </main>
    )
  }

  const invalidTask = !flow.analysisTask && !hasResult

  return (
    <main className={styles.page}>
      <div className={`${styles.shell} ${styles.enter}`}>
        <nav className={styles.topbar} aria-label="分析页面导航">
          <button type="button" className={styles.backLink} onClick={cancelAnalysis}>
            <ArrowLeft size={15} strokeWidth={1.7} aria-hidden="true" />
            返回生成作品
          </button>
          <span className={styles.brandWord}>VISION ANALYSIS</span>
        </nav>

        <div className={styles.analysisGrid}>
          <section className={styles.analysisMain} aria-labelledby="analysis-title">
            <p className={styles.eyebrow}>{inspirationTask ? '灵感分析' : '创作分析'}</p>
            <h1 id="analysis-title" className={styles.analysisTitle}>
              {invalidTask ? '没有可继续的分析任务' : title}
            </h1>
            <p className={styles.analysisTopic}>
              {invalidTask
                ? '返回入口页重新写下你的创作主题。'
                : `“${flow.topic}”`}
            </p>

            {!invalidTask && flow.analysisStatus !== 'error' && (
              <ol className={styles.timeline} aria-live="polite" aria-label="分析进度">
                {steps.map((step, index) => {
                  const state =
                    index < analysisStep
                      ? 'done'
                      : index === analysisStep
                        ? 'active'
                        : 'pending'
                  return (
                    <li key={step} className={styles.timelineItem} data-state={state}>
                      <span className={styles.timelineNode} aria-hidden="true" />
                      <span>{step}</span>
                    </li>
                  )
                })}
              </ol>
            )}

            {flow.analysisStatus === 'error' && (
              <div className={styles.errorPanel} role="alert">
                <h2 className={styles.errorTitle}>分析没有完成</h2>
                <p className={styles.errorMessage}>{flow.error}</p>
                <div className={styles.actions}>
                  <button type="button" className={styles.primaryButton} onClick={retryAnalysis}>
                    <RotateCcw size={16} strokeWidth={1.8} aria-hidden="true" />
                    重新分析
                  </button>
                  <button type="button" className={styles.secondaryButton} onClick={cancelAnalysis}>
                    返回修改
                  </button>
                </div>
              </div>
            )}

            <div className={styles.analysisFooter}>
              <p className={styles.analysisHint}>
                {flow.analysisStatus === 'error'
                  ? '重新分析前不会重复发起请求。'
                  : '通常需要 10-40 秒。离开此页将停止等待结果。'}
              </p>
              {!invalidTask && flow.analysisStatus !== 'error' && (
                <button type="button" className={styles.textButton} onClick={cancelAnalysis}>
                  取消分析
                </button>
              )}
              {invalidTask && (
                <button type="button" className={styles.textButton} onClick={cancelAnalysis}>
                  返回入口
                </button>
              )}
            </div>
          </section>

          <aside className={styles.analysisAside} aria-label="分析状态说明">
            <p className={styles.analysisAsideLabel}>CURRENT FOCUS</p>
            <p className={styles.analysisAsideValue}>{aside}</p>
            <code className={styles.analysisAsidePath}>
              /images/vision/creation-illustration.png
            </code>
          </aside>
        </div>
      </div>
    </main>
  )
}
