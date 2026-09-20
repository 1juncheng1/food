// ============================================================
// WF7：pickInspirationView —— 三段式卡片视图模型回退规则
//
// 覆盖矩阵：
//   AI 卡（五字段齐全）     → 三段全展示 + 素材行
//   AI 卡缺 creation_angle → 该段 null（UI 隐藏），其余正常
//   旧 v1 卡（五字段 null） → whyForYou 回退模板 reason，AI 段全隐藏
//   模板卡（reason_source 缺失）→ 同旧卡
//   AI 卡但 why_recommend 空 → 视为模板卡（hasAiReason 契约）
// ============================================================

import { describe, expect, it } from 'vitest'
import { pickInspirationView, type InspirationApiRow } from './inspirationView'

const AI_ROW: InspirationApiRow = {
  title: '为什么年轻人开始逃离北上广',
  description: 'D',
  reason: '最近 30 天生成 2 篇「该方向」相关内容', // 模板理由（回退备用）
  why_recommend: '你在「逃离北上广」方向已生成过 2 篇，说明你有真实关注',
  creation_angle: '找几个真实的离开者案例，算一算实际收支账',
  core_question: '年轻人离开北上广，是主动选择还是被现实推着走？',
  related_knowledge: ['大城市生活成本对比素材', '青年迁移报告'],
  reason_source: 'ai',
  rec_id: 'rec-1',
}

describe('pickInspirationView（WF7 三段式视图模型）', () => {
  it('AI 卡：三段全出、素材行保留、reasonSource=ai', () => {
    const v = pickInspirationView(AI_ROW)
    expect(v).toEqual({
      title: AI_ROW.title,
      whyForYou: AI_ROW.why_recommend,
      coreQuestion: AI_ROW.core_question,
      creationAngle: AI_ROW.creation_angle,
      relatedKnowledge: ['大城市生活成本对比素材', '青年迁移报告'],
      reasonSource: 'ai',
    })
  })

  it('素材裁剪到 3 条以内', () => {
    const v = pickInspirationView({
      ...AI_ROW,
      related_knowledge: ['a', 'b', 'c', 'd', 'e'],
    })
    expect(v.relatedKnowledge).toEqual(['a', 'b', 'c'])
  })

  it('AI 卡缺 creation_angle → 该段 null，其余三段正常', () => {
    const v = pickInspirationView({ ...AI_ROW, creation_angle: null })
    expect(v.creationAngle).toBeNull()
    expect(v.coreQuestion).toBe(AI_ROW.core_question)
    expect(v.whyForYou).toBe(AI_ROW.why_recommend)
  })

  it('旧 v1 卡（五字段 null）→ 回退模板 reason，AI 专属段全隐藏', () => {
    const v = pickInspirationView({
      title: '旧卡',
      description: '旧描述',
      reason: '最近 30 天生成 4 篇「AI创业」相关内容',
      why_recommend: null,
      creation_angle: null,
      core_question: null,
      related_knowledge: null,
      reason_source: 'template',
    })
    expect(v.whyForYou).toBe('最近 30 天生成 4 篇「AI创业」相关内容')
    expect(v.coreQuestion).toBeNull()
    expect(v.creationAngle).toBeNull()
    expect(v.relatedKnowledge).toEqual([])
    expect(v.reasonSource).toBe('template')
  })

  it('模板卡（五字段缺失，字段 undefined）→ 同旧卡回退', () => {
    const v = pickInspirationView({
      title: '模板卡',
      description: '模板描述',
      reason: '平台模板',
    })
    expect(v.whyForYou).toBe('平台模板')
    expect(v.reasonSource).toBe('template')
    expect(v.relatedKnowledge).toEqual([])
  })

  it('AI 卡但 why_recommend 为空串 → hasAiReason 契约：视为模板卡回退', () => {
    const v = pickInspirationView({ ...AI_ROW, why_recommend: '' })
    expect(v.reasonSource).toBe('ai') // 标记保留（诚实），但
    expect(v.whyForYou).toBe(AI_ROW.reason) // 内容回退
    expect(v.coreQuestion).toBeNull()
    expect(v.creationAngle).toBeNull()
  })
})
