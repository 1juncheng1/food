import { describe, expect, it } from 'vitest'
import { detectInteractionMode } from './workAgentMode'

describe('detectInteractionMode', () => {
  it('用户明示别问了 → direct（再给候选就是违背指令）', () => {
    expect(detectInteractionMode('别问了，直接改').mode).toBe('direct')
    expect(detectInteractionMode('你直接修改吧').mode).toBe('direct')
  })

  it('创作受阻/情绪信号 → companion，优先于其中的改稿诉求', () => {
    // 这句同时含"没人看"(陪伴) 与"帮我改"(改稿诉求)，陪伴优先：
    // 用户此刻更需要先被理解，陪伴回复里会留继续改的入口，不会把他堵死
    expect(detectInteractionMode('我感觉写出来没人看，帮我改一下').mode).toBe('companion')
    expect(detectInteractionMode('写不下去，不知道写什么了').mode).toBe('companion')
  })

  it('征询判断 → discuss', () => {
    expect(detectInteractionMode('你觉得这篇最大的问题在哪？').mode).toBe('discuss')
    expect(detectInteractionMode('帮我分析一下为什么读起来怪怪的').mode).toBe('discuss')
  })

  it('普通修改反馈 → suggest（既有三步流水线）', () => {
    expect(detectInteractionMode('开头太平了，没什么记忆点').mode).toBe('suggest')
    expect(detectInteractionMode('结尾升华不够').mode).toBe('suggest')
  })

  it('未命中任何规则时也回退 suggest——本模块只会让对话更贴合，不会让既有链路退化', () => {
    const r = detectInteractionMode('随便写点什么吧')
    expect(r.mode).toBe('suggest')
    expect(r.confidence).toBe('fallback')
  })

  it('过短输入不做判定，避免误伤', () => {
    expect(detectInteractionMode('嗯').mode).toBe('suggest')
    expect(detectInteractionMode('').confidence).toBe('fallback')
  })

  it('direct 优先于 companion：用户说了"直接改"就不能再拦一轮', () => {
    expect(detectInteractionMode('没人看，别问了直接改').mode).toBe('direct')
  })
})
