'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { CREATION_MODE_META, CREATION_MODES } from '@/lib/creative/personalization'
import { CREATOR_LEVEL_META } from '@/lib/creative/creatorStatus'
import { amountForPoints } from '@/lib/points'
import { MIN_GENERATION_COST } from '@/lib/balance'
import {
  WORD_COUNT_MAX,
  WORD_COUNT_MIN,
} from '@/lib/creative/wordCount'
import {
  InterviewDialog,
  useInterviewTrigger,
} from '@/components/creative/interview-dialog'
import { useCreationFlow } from '@/components/generate/creation-flow-provider'
import { CREATION_IMAGES } from '@/lib/vision-assets'
import styles from './creation-flow.module.css'

export default function GenerateEntryPage() {
  const {
    flow,
    hydrated,
    account,
    setTopic,
    selectMode,
    setWordCount,
    beginPlanAnalysis,
    beginInspirationAnalysis,
  } = useCreationFlow()
  const interviewTrigger = useInterviewTrigger(account.isLoggedIn, account.accessToken)
  const creatorMeta = account.creatorStatus
    ? CREATOR_LEVEL_META[account.creatorStatus.level]
    : null
  const busy = flow.analysisStatus === 'queued' || flow.analysisStatus === 'running'
  const preparing = !hydrated || !account.authReady
  const disabled = preparing || busy

  // 目标字数的输入草稿：只有落在合法区间才写进流程状态，
  // 让用户能正常"边打字边改"（输入 15 不会在打到一半时被清空）。
  // 外部状态（刷新恢复 / 清除）变化时用渲染期同步，避免 effect 引发级联渲染。
  const [wordDraft, setWordDraft] = useState('')
  const [syncedWordCount, setSyncedWordCount] = useState<number | null>(null)
  if (syncedWordCount !== flow.wordCount) {
    setSyncedWordCount(flow.wordCount)
    setWordDraft(flow.wordCount !== null ? String(flow.wordCount) : '')
  }

  const wordInvalid = wordDraft.trim() !== '' && flow.wordCount === null

  function handleWordChange(value: string) {
    setWordDraft(value)
    const trimmed = value.trim()
    if (!trimmed) {
      setWordCount(null)
      return
    }
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed) && parsed >= WORD_COUNT_MIN && parsed <= WORD_COUNT_MAX) {
      setWordCount(Math.round(parsed))
    } else if (flow.wordCount !== null) {
      setWordCount(null)
    }
  }

  return (
    <main className={styles.page} data-mode={flow.mode}>
      <div className={`${styles.shell} ${styles.enter}`}>
        <nav className={styles.topbar} aria-label="页面导航">
          <Link href="/dashboard" className={styles.backLink}>
            <ArrowLeft size={15} strokeWidth={1.7} aria-hidden="true" />
            返回主页
          </Link>
          <span className={styles.brandWord}>VISION CREATION</span>
        </nav>

        <div className={styles.entryGrid}>
          <section className={styles.entryMain} aria-labelledby="creation-title">
            <p className={styles.eyebrow}>生成作品</p>
            <h1 id="creation-title" className={styles.title}>
              你想创作什么？
            </h1>
            <p className={styles.lead}>
              从一个主题开始。银河叙事会先理解你的意图，再与你一起确定创作方向。
            </p>

            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault()
                beginPlanAnalysis()
              }}
            >
              <label htmlFor="creation-topic" className={styles.fieldLabel}>
                创作主题或想法
              </label>
              <textarea
                id="creation-topic"
                className={styles.topicInput}
                value={flow.topic}
                onChange={(event) => setTopic(event.target.value)}
                placeholder="写下一句话、一个选题，或你真正想表达的观点"
                rows={3}
                maxLength={500}
                autoFocus
                disabled={busy}
              />
              <p className={styles.helper}>
                不需要整理成 Prompt。保留你原本的表达，AI 会在下一步完成理解与分析。
              </p>

              <section className={styles.modeSection} aria-labelledby="creation-mode-label">
                <p id="creation-mode-label" className={styles.sectionLabel}>
                  创作方式
                </p>
                <div className={styles.modeGrid} role="radiogroup" aria-label="创作方式">
                  {CREATION_MODES.map((mode) => {
                    const selected = flow.mode === mode
                    return (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        data-active={selected}
                        className={styles.modeButton}
                        onClick={() => selectMode(mode)}
                        disabled={busy}
                      >
                        <span className={styles.modeName}>{CREATION_MODE_META[mode].label}</span>
                        <span className={styles.modeDescription}>
                          {CREATION_MODE_META[mode].tagline}
                        </span>
                      </button>
                    )
                  })}
                </div>

                <p className={styles.modeNote}>
                  {flow.mode === 'creator' && account.isLoggedIn
                    ? account.creatorStatus
                      ? `${creatorMeta?.label ?? '专属创作助手已就位'}，理解程度 ${account.creatorStatus.percent}%`
                      : '将参考你的创作者人格、素材库与历史作品'
                    : '基于平台通用创作经验探索新的表达方向'}
                </p>
              </section>

              <section className={styles.wordSection} aria-labelledby="creation-word-label">
                <p id="creation-word-label" className={styles.sectionLabel}>
                  目标字数 <span className={styles.optionalMark}>可选</span>
                </p>
                <div className={styles.wordRow}>
                  <input
                    id="creation-word-count"
                    className={styles.wordInput}
                    type="number"
                    inputMode="numeric"
                    min={WORD_COUNT_MIN}
                    max={WORD_COUNT_MAX}
                    value={wordDraft}
                    onChange={(event) => handleWordChange(event.target.value)}
                    placeholder="由 AI 判断"
                    disabled={busy}
                  />
                  <span className={styles.wordUnit}>字</span>
                  {flow.wordCount !== null && (
                    <button
                      type="button"
                      className={styles.wordClear}
                      onClick={() => setWordCount(null)}
                      disabled={busy}
                    >
                      清除
                    </button>
                  )}
                </div>
                <p className={styles.helper}>
                  {wordInvalid
                    ? `请填写 ${WORD_COUNT_MIN} - ${WORD_COUNT_MAX} 之间的字数，或留空交给 AI 判断。`
                    : '填写后，方案与正文都按这个字数走；留空则由 AI 按主题的表达容量决定。'}
                </p>
              </section>

              {account.isLoggedIn && account.balance !== null && (
                <p className={styles.balance}>
                  {account.balance < MIN_GENERATION_COST ? (
                    <>
                      当前余额不足
                      <Link href="/recharge" className={styles.balanceLink}>
                        去充值
                      </Link>
                    </>
                  ) : (
                    <>
                      账户余额 {account.balance} 积分
                      {account.pointsPerYuan !== null
                        ? `，约 ¥${amountForPoints(account.balance, account.pointsPerYuan).toFixed(2)}`
                        : ''}
                    </>
                  )}
                </p>
              )}

              {flow.error && (
                <div className={styles.error} role="alert">
                  {flow.error}
                </div>
              )}

              <div className={styles.actions}>
                <button type="submit" className={styles.primaryButton} disabled={disabled}>
                  {preparing ? '正在准备' : '开始分析'}
                  <ArrowRight size={17} strokeWidth={1.8} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.tertiaryButton}
                  onClick={beginInspirationAnalysis}
                  disabled={disabled || !flow.topic.trim()}
                >
                  分析这个灵感值不值得做
                </button>
              </div>
            </form>
          </section>

          {/* 右侧主视觉：真实素材来自 CREATION_IMAGES.hero，整张图完整展示不裁切 */}
          <aside className={styles.visualColumn} aria-label="创作视觉素材">
            <figure className={styles.visualFrame}>
              <img
                src={CREATION_IMAGES.hero}
                alt="银河叙事创作主视觉"
                width={862}
                height={1080}
                className={styles.visualHero}
              />
            </figure>
            <div className={styles.visualSecondary}>
              <p className={styles.visualCaption}>Creative Illustration</p>
              <code className={styles.visualPath}>{CREATION_IMAGES.illustration}</code>
            </div>
          </aside>
        </div>
      </div>

      <InterviewDialog
        open={interviewTrigger.shouldShow}
        accessToken={account.accessToken}
        onCompleted={() => interviewTrigger.refresh()}
        onDismiss={() => interviewTrigger.refresh()}
      />
    </main>
  )
}
