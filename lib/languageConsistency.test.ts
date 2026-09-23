import { describe, expect, it } from 'vitest'
import {
  checkLanguageConsistency,
  detectLanguage,
  extractUserFacingText,
  languageDirective,
  resolveTargetLanguage,
  type LanguageCode,
} from './languageConsistency'

describe('detectLanguage', () => {
  const cases: Array<[string, LanguageCode]> = [
    // 纯语种
    ['这篇稿子太平了，开头缺少一个能抓住人的钩子，读到最后也没什么记忆点。', 'zh-CN'],
    ['The story feels flat and the opening never hooks the reader.', 'en'],
    ['この文章は緊張感が足りなくて、キャラクターの描写が浅いと思います。', 'ja'],
    ['이 글은 긴장감이 부족하고 캐릭터 묘사가 너무 얕습니다.', 'ko'],
    ['Проблема в том, что в тексте мало напряжения и нет кульминации.', 'ru'],
    ['المشكلة أن النص لا يحتوي على توتر كافٍ ولا نهاية مؤثرة.', 'ar'],
    ['El problema es que la narrativa no tiene tensión y los personajes están planos.', 'es'],
    ['Le problème, c’est que le récit manque de tension et les personnages sont plats.', 'fr'],
    ['Das Problem ist, dass die Erzählung zu wenig Spannung hat und die Figuren flach sind.', 'de'],
    ['O problema é que a narrativa não tem tensão e os personagens são rasos.', 'pt'],
    ['Il problema è che la narrazione non ha abbastanza tensione e i personaggi sono piatti.', 'it'],
  ]

  it.each(cases)('识别语言：%s', (text, expected) => {
    expect(detectLanguage(text).language).toBe(expected)
  })

  it('繁体比例足够时判为 zh-TW', () => {
    const d = detectLanguage(
      '這個故事的節奏太慢了，角色刻畫也不夠鮮明，我覺得應該重新調整結構。'
    )
    expect(d.language).toBe('zh-TW')
  })

  it('简体特征占优时判为 zh-CN', () => {
    const d = detectLanguage('这个故事节奏太慢了，角色刻画也不够鲜明，我觉得应该重新调整结构。')
    expect(d.language).toBe('zh-CN')
  })

  it('中英混写仍判中文（混写是中文用户的常态，不能被几个英文词翻盘）', () => {
    const d = detectLanguage('这篇 script 的 hook 不够强，开头要 refine 一下 narrative arc。')
    expect(d.language).toBe('zh-CN')
  })

  it('正文夹大量 URL / 邮箱 / 数字也不影响中文判定', () => {
    const text =
      '参考资料：https://example.com/post?id=12 联系 hi@foo.com 2026 年数据见下文。这篇分析仍然是一篇中文稿子，我们需要判断它的语言倾向是否稳定。'
    expect(detectLanguage(text).language).toBe('zh-CN')
  })

  it('代码块内的英文不参与统计', () => {
    const text = '说明：\n```select * from users where id = 1```\n以上是一个简单的查询语句示例说明。'
    expect(detectLanguage(text).language).toBe('zh-CN')
  })

  it('样本不足时返回 unknown，而不是硬猜一个语言', () => {
    expect(detectLanguage('').language).toBe('unknown')
    expect(detectLanguage('   ').language).toBe('unknown')
    expect(detectLanguage('2026!! 🎉🎉').language).toBe('unknown')
  })

  it('同一输入多次检测结果恒定（纯函数，不抖动）', () => {
    const t = '这篇稿子偏题了，需要重写。'
    expect(detectLanguage(t)).toEqual(detectLanguage(t))
  })
})

describe('resolveTargetLanguage', () => {
  it('按权重选择能明确判出的候选', () => {
    const r = resolveTargetLanguage([
      { text: '', weight: 100, label: 'feedback' }, // 用户没填意见
      { text: 'The opening lacks tension.', weight: 50, label: 'topic' },
      { text: '这是一篇中文稿子，讲述的内容值得展开。', weight: 10, label: 'note' },
    ])
    expect(r.language).toBe('en')
    expect(r.source).toBe('topic')
  })

  it('用户本次反馈优先于历史正文（用户此刻的输入最能代表当前意图）', () => {
    const r = resolveTargetLanguage([
      { text: '这是一篇很久以前的中文正文内容，内容长度足够被识别出来。', weight: 10, label: 'article' },
      { text: 'Please make the ending more emotional and impactful.', weight: 100, label: 'feedback' },
    ])
    expect(r.language).toBe('en')
    expect(r.source).toBe('feedback')
  })

  it('全部候选无法判定时返回 unknown', () => {
    const r = resolveTargetLanguage([
      { text: '🎉', weight: 10, label: 'a' },
      { text: '12345', weight: 5, label: 'b' },
    ])
    expect(r.language).toBe('unknown')
  })

  it('候选为空不崩溃', () => {
    expect(resolveTargetLanguage([]).language).toBe('unknown')
  })
})

describe('languageDirective', () => {
  it('指定语言时给出明确语言名，并豁免技术字段', () => {
    const d = languageDirective('en')
    expect(d).toContain('English')
    expect(d).toContain('slug')
  })

  it('支持自定义豁免字段（naming 的 slug 必须保持蛇形码）', () => {
    const d = languageDirective('zh-CN', { exemptFields: ['slug', 'cluster_id'] })
    expect(d).toContain('slug')
    expect(d).toContain('cluster_id')
  })

  it('unknown 时退化为「跟随输入」而不是放弃约束', () => {
    const d = languageDirective('unknown')
    expect(d).toContain('保持完全一致')
    expect(d).toContain('简体中文') // 兜底默认
  })
})

describe('checkLanguageConsistency', () => {
  it('语言一致时通过', () => {
    const r = checkLanguageConsistency('这篇稿子需要更强的开头钩子与情绪峰值。', 'zh-CN')
    expect(r.consistent).toBe(true)
  })

  it('目标是中文却输出英文时判为不一致，并给出可排查依据', () => {
    const r = checkLanguageConsistency('The article needs a stronger opening hook.', 'zh-CN')
    expect(r.consistent).toBe(false)
    expect(r.detected.language).toBe('en')
    expect(r.note).toContain('zh-CN')
  })

  it('简繁混用不算不一致（同一语言变体，苛判会引发无意义重试）', () => {
    const r = checkLanguageConsistency('這個設定不錯，但结构还需要调整一下。', 'zh-CN')
    expect(r.consistent).toBe(true)
  })

  it('目标 unknown 时不做判定', () => {
    expect(checkLanguageConsistency('anything', 'unknown').consistent).toBe(true)
  })

  it('输出本身无法判定语言时放行（短数字输出不该触发重试）', () => {
    const r = checkLanguageConsistency('42', 'zh-CN')
    expect(r.consistent).toBe(true)
    expect(r.note).toContain('undetectable')
  })
})

describe('extractUserFacingText', () => {
  it('跳过 JSON key 与技术标识符，只收集面向用户的文本', () => {
    const json = {
      label: 'AI 商业落地',
      slug: 'c_ai_business',
      summary: '围绕 AI 在商业场景中的落地路径与常见坑点展开讨论。',
      cluster_id: 'cluster_9f2a',
      tags: ['选题', 'AI'],
    }
    const text = extractUserFacingText(json)
    expect(text).toContain('AI 商业落地')
    expect(text).toContain('落地路径')
    expect(text).not.toContain('c_ai_business')
    expect(text).not.toContain('cluster_9f2a')
  })

  it('纯中文 JSON 抽出的文本应被判为中文（英文 key 已剥离）', () => {
    const json = { title: '开头钩子设计', reason: '缺乏记忆点，读者流失在中段', score: 72 }
    expect(detectLanguage(extractUserFacingText(json)).language).toBe('zh-CN')
  })

  it('深嵌套与数组都能遍历到', () => {
    const json = { a: { b: [{ c: '深层中文文本用于递归抽取验证' }] } }
    expect(extractUserFacingText(json)).toContain('深层中文文本')
  })
})
