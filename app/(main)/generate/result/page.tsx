'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, X } from 'lucide-react'
import { ClarifyPanel } from '@/components/generate/clarify-panel'
import { InspirationAnalysisCard } from '@/components/generate/inspiration-analysis-card'
import { MaterialSelector } from '@/components/generate/material-selector'
import { PlanPanel } from '@/components/generate/plan-panel'
import { useCreationFlow } from '@/components/generate/creation-flow-provider'
import styles from '../creation-flow.module.css'

const RESULT_META = {
  insight: {
    eyebrow: '灵感分析',
    title: '这个想法，可以这样判断',
    description: '先看创作空间与差异化，再决定是否进入创作。',
  },
  clarify: {
    eyebrow: '意图确认',
    title: '再确认几件重要的事',
    description: '只补齐会影响创作方向的信息。',
  },
  plan: {
    eyebrow: '创作方案',
    title: '方向已经形成',
    description: '确认 AI 的理解与创作方向，然后进入真正的创作。',
  },
  materials: {
    eyebrow: '创作素材',
    title: '选择这次要带入的素材',
    description: '只在我的模式中出现，选择仅对本次创作生效。',
  },
} as const

export default function CreationResultPage() {
  const router = useRouter()
  const {
    flow,
    hydrated,
    account,
    effectiveMode,
    hasResult,
    clearError,
    goToEntry,
    resetInspiration,
    analyzeMarketOpportunity,
    startCreationFromInspiration,
    startCreationFromMarketGap,
    submitClarifications,
    skipClarification,
    beginPlanAnalysis,
    handleConfirmPlan,
    handleConfirmMaterials,
    handleBackFromMaterials,
    handleSolve,
    unlockPlan,
  } = useCreationFlow()

  // 结果页从灵感/澄清阶段再次发起分析时，状态会短暂切回 analyzing，
  // 此时不能把它当作“没有结果”而抢先跳回入口页。
  const pendingAnalysis =
    flow.analysisTask !== null ||
    flow.analysisStatus === 'queued' ||
    flow.analysisStatus === 'running'

  useEffect(() => {
    if (hydrated && !hasResult && !pendingAnalysis) router.replace('/generate')
  }, [hasResult, hydrated, pendingAnalysis, router])

  if (!hydrated || !hasResult) {
    return (
      <main className={styles.page}>
        <div className={styles.loadingState}>正在恢复创作结果</div>
      </main>
    )
  }

  const stage = flow.stage as keyof typeof RESULT_META
  const meta = RESULT_META[stage]

  return (
    <main className={styles.page}>
      <div className={`${styles.resultShell} ${styles.enter}`}>
        <nav className={styles.topbar} aria-label="结果页面导航">
          <button type="button" className={styles.backLink} onClick={goToEntry}>
            <ArrowLeft size={15} strokeWidth={1.7} aria-hidden="true" />
            返回生成作品
          </button>
          <span className={styles.brandWord}>VISION RESULT</span>
        </nav>

        <header className={styles.resultHeader}>
          <div className={styles.resultHeaderCopy}>
            <p className={styles.eyebrow}>{meta.eyebrow}</p>
            <h1 className={styles.resultTitle}>{meta.title}</h1>
            <p className={styles.resultTopic}>{meta.description}</p>
          </div>
          <p className={styles.resultMeta}>{flow.analyzedTopic || flow.topic}</p>
        </header>

        <section className={styles.resultSurface} aria-label={meta.eyebrow}>
          <div className={styles.resultContent}>
            {flow.error && (
              <div className={styles.resultError} role="alert">
                <span>{flow.error}</span>
                <button type="button" className={styles.textButton} onClick={clearError} aria-label="关闭错误提示">
                  <X size={14} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </div>
            )}

            {flow.stage === 'insight' && flow.inspirationAnalysis && (
              <InspirationAnalysisCard
                analysis={flow.inspirationAnalysis}
                recalledMaterials={flow.recalledMaterials}
                marketReport={flow.marketReport}
                marketLoading={flow.marketLoading}
                onMarketAnalysis={() => void analyzeMarketOpportunity()}
                onStartCreation={startCreationFromInspiration}
                onStartCreationFromMarket={startCreationFromMarketGap}
                onReset={resetInspiration}
                loading={flow.analysisStatus === 'queued' || flow.analysisStatus === 'running'}
              />
            )}

            {flow.stage === 'clarify' && flow.clarifyQuestions.length > 0 && (
              <ClarifyPanel
                topic={flow.analyzedTopic}
                questions={flow.clarifyQuestions}
                inferred={flow.clarifyInferred}
                reason={flow.clarifyReason}
                onSubmit={submitClarifications}
                onSkip={skipClarification}
                onBack={goToEntry}
                loading={flow.analysisStatus === 'queued' || flow.analysisStatus === 'running'}
              />
            )}

            {flow.stage === 'plan' && flow.plan && (
              <PlanPanel
                plan={flow.plan}
                topic={flow.analyzedTopic}
                knowledgeUnits={flow.planKnowledge}
                confirmed={!!flow.confirmedPlan}
                onConfirm={handleConfirmPlan}
                onReanalyze={() => beginPlanAnalysis()}
                onSolve={handleSolve}
                onBack={goToEntry}
                onBackToEdit={unlockPlan}
              />
            )}

            {flow.stage === 'materials' && flow.confirmedPlan && effectiveMode !== 'inspiration' && (
              <MaterialSelector
                topic={flow.topic.trim()}
                blueprintUsageTag={flow.confirmedPlan.usage_tag ?? null}
                blueprintContentType={flow.confirmedPlan.content_type ?? null}
                accessToken={account.accessToken ?? ''}
                onConfirm={handleConfirmMaterials}
                onBack={handleBackFromMaterials}
              />
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
