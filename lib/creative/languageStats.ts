// ============================================================
// languageStats —— 确定性语言特征统计（无 LLM、无副作用纯函数）
//
// 两处读者共用同一口径，禁止各自重写：
//   1. /api/style-profile：风格卡基础四项（语气/节奏/开头/均长）
//   2. /api/style-profile/summarize：创作 DNA 报告的确定性骨架
// 口径升级（如换向量相似度）只改本文件。
// ============================================================

/** 语气标签关键词词典：对每篇内容做子串匹配，命中即打标 */
const TONE_KEYWORDS: Record<string, string[]> = {
  犀利: ['犀利', '锋利', '刺穿', '直击', '一针见血', '毫不留情', '残酷', '冰冷'],
  幽默: ['幽默', '搞笑', '有趣', '段子', '笑', '梗', '逗', '滑稽', '荒诞'],
  温情: ['温情', '温暖', '感动', '泪', '柔软', '治愈', '温柔', '幸福', '爱'],
  悬疑: ['悬疑', '谜', '秘密', '诡异', '未知', '真相', '线索', '隐藏', '背后'],
  热血: ['热血', '燃', '战斗', '冲锋', '拼搏', '不屈', '怒吼', '燃烧'],
  专业: ['分析', '数据', '研究', '原理', '结构', '逻辑', '系统', '拆解'],
}

export interface BasicLanguageStats {
  tone_tags: string[]
  pace_preference: string
  common_opening: string
  avg_length: number
}

/** 每个语气标签命中的篇数（同一篇内同标签只计 1 次，避免重复计数） */
export function toneTagCounts(contents: string[]): { label: string; count: number }[] {
  return Object.entries(TONE_KEYWORDS).map(([label, keywords]) => {
    let count = 0
    for (const text of contents) {
      if (keywords.some((kw) => text.includes(kw))) count += 1
    }
    return { label, count }
  })
}

/** 命中篇数 > 0 的语气标签（保持原风格卡口径） */
export function extractToneTags(contents: string[]): string[] {
  return toneTagCounts(contents)
    .filter((x) => x.count > 0)
    .map((x) => x.label)
}

/**
 * 节奏判断：平均句长 = 总字符 / 句末标点（。！？!?）数。
 * <20 快节奏；>40 慢节奏；其余中等。
 */
export function detectPace(contents: string[]): string {
  let totalChars = 0
  let totalSentences = 0

  for (const text of contents) {
    totalChars += text.replace(/\s/g, '').length
    const sentenceEndings = (text.match(/[。！？!?]/g) ?? []).length
    totalSentences += Math.max(sentenceEndings, 1)
  }

  if (totalSentences === 0) return '未知'
  const avgSentenceLen = totalChars / totalSentences
  if (avgSentenceLen < 20) return '快节奏'
  if (avgSentenceLen > 40) return '慢节奏'
  return '中等'
}

const NARRATIVE_STARTERS = ['这个男人', '这个女人', '他', '她', '他们', '那个', '这位']

/** 开头方式分布：提问式 / 叙事式 / 其他（一篇只归一类） */
export function openingCounts(contents: string[]): {
  question: number
  narrative: number
  other: number
} {
  let question = 0
  let narrative = 0
  let other = 0
  for (const text of contents) {
    const head = text.trim().slice(0, 10)
    if (!head) {
      other += 1
    } else if (head.startsWith('你') || head.includes('？') || head.includes('?')) {
      question += 1
    } else if (NARRATIVE_STARTERS.some((s) => head.startsWith(s))) {
      narrative += 1
    } else {
      other += 1
    }
  }
  return { question, narrative, other }
}

/** 多数决开头方式（提问/叙事均为 0 时未知，保持原风格卡口径） */
export function detectOpening(contents: string[]): string {
  const { question, narrative } = openingCounts(contents)
  if (question === 0 && narrative === 0) return '未知'
  return question >= narrative ? '提问式' : '叙事式'
}

/** 全部历史内容 → 风格卡基础四项（空内容返回零值） */
export function computeBasicStats(allContents: string[]): BasicLanguageStats {
  if (allContents.length === 0) {
    return {
      tone_tags: [],
      pace_preference: '未知',
      common_opening: '未知',
      avg_length: 0,
    }
  }
  const totalChars = allContents.reduce((sum, t) => sum + t.replace(/\s/g, '').length, 0)
  return {
    tone_tags: extractToneTags(allContents),
    pace_preference: detectPace(allContents),
    common_opening: detectOpening(allContents),
    avg_length: Math.round(totalChars / allContents.length),
  }
}
