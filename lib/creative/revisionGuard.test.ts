import { describe, expect, it } from 'vitest'
import { assessRevisionRequest } from './revisionGuard'

describe('assessRevisionRequest', () => {
  it('术语替换：提示理解门槛，并给出"用案例解释"的替代方案', () => {
    const a = assessRevisionRequest('把所有专业词换成高级词')
    expect(a?.ruleId).toBe('terminology_swap')
    expect(a?.better).toContain('案例')
  })

  it('通篇堆金句：提示情绪碎片化', () => {
    expect(assessRevisionRequest('每句都要有金句，再煽情一点')?.ruleId).toBe(
      'hollow_punchline'
    )
  })

  it('凑长度：提示信息密度下降', () => {
    expect(assessRevisionRequest('再写长一点，凑够 1500 字')?.ruleId).toBe('length_padding')
  })

  it('模仿他人语气：这是产品定位层面最不能照做的一条', () => {
    const a = assessRevisionRequest('模仿那个大V的风格写')
    expect(a?.ruleId).toBe('imitate_others')
    expect(a?.why).toContain('银河叙事')
  })

  it('整篇重写：提示会丢掉已满意的部分', () => {
    expect(assessRevisionRequest('整篇重写吧')?.ruleId).toBe('blanket_rewrite')
  })

  it('正常修改诉求不提示——误报会让用户学会无视守门', () => {
    expect(assessRevisionRequest('开头不够吸引人')).toBeNull()
    expect(assessRevisionRequest('加一个真实案例')).toBeNull()
    expect(assessRevisionRequest('结尾升华弱了一点')).toBeNull()
  })

  it('每条提示都必须带替代方案，否则等于把问题丢回给用户', () => {
    const samples = [
      '换成高级词汇',
      '每段都要金句',
      '拉长到 2000 字',
      '照着爆款的文风写',
      '从头推翻重写',
    ]
    for (const s of samples) {
      const a = assessRevisionRequest(s)
      expect(a, s).not.toBeNull()
      expect(a!.better.length, s).toBeGreaterThan(0)
      expect(a!.concern.length, s).toBeGreaterThan(0)
    }
  })

  it('过短输入不守门', () => {
    expect(assessRevisionRequest('改')).toBeNull()
  })
})
