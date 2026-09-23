// ============================================================
// inferUsageFilter 搬迁验证（plan 步骤 2/7）
// 从 prompt-optimizer/route.ts 原样迁入 lib/material/usageFilter.ts，
// 三条优先级路径行为必须与旧实现一致。
// ============================================================

import { describe, expect, it } from 'vitest'
import type { WorkTags } from '@/lib/creative/workAnalysis'
import { inferUsageFilter, CATEGORY_TO_USAGE } from './usageFilter'

function tagsWith(usageTags: string[]): WorkTags {
  return {
    work_type: '',
    theme: '',
    expression_style: '',
    emotion: '',
    audience: '',
    narrative_structure: '',
    core_viewpoint: '',
    content_tags: [],
    emotion_tags: [],
    expression_tags: [],
    audience_tags: [],
    thought_tags: [],
    usage_tags: usageTags as WorkTags['usage_tags'],
  }
}

describe('inferUsageFilter：三级优先级', () => {
  it('优先级 1：improve 模式 prevWorkTags.usage_tags[0] 压倒一切', () => {
    const result = inferUsageFilter(
      '商业分析',
      '剧情素材',
      tagsWith(['结尾升华', '开头钩子'])
    )
    expect(result).toBe('结尾升华')
  })

  it('优先级 2：无 prevTags 时用 AI 方案直接输出的 usage_tag', () => {
    expect(inferUsageFilter('商业分析', '剧情素材', null)).toBe('剧情素材')
    expect(inferUsageFilter('电影解说', '标题灵感', tagsWith([]))).toBe('标题灵感')
  })

  it('优先级 3：只剩 content_type 时走 CATEGORY_TO_USAGE 映射', () => {
    expect(inferUsageFilter('商业分析', undefined, null)).toBe('观点素材')
    expect(inferUsageFilter('产品评测', undefined, null)).toBe('案例素材')
  })

  it('三条信号全空 → null（纯向量召回，不硬过滤）', () => {
    expect(inferUsageFilter('不存在的品类', undefined, null)).toBeNull()
    expect(inferUsageFilter('', undefined, tagsWith([]))).toBeNull()
  })

  it('映射表关键条目搬迁完整', () => {
    expect(CATEGORY_TO_USAGE['电影解说']).toBe('剧情素材')
    expect(CATEGORY_TO_USAGE['商业计划书']).toBe('结构参考')
    expect(CATEGORY_TO_USAGE['读书解读']).toBe('观点素材')
    expect(Object.keys(CATEGORY_TO_USAGE)).toHaveLength(11)
  })
})
