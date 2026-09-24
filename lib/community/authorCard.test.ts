import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAuthorCards,
  missingAuthorIds,
  normalizeAuthorCard,
} from './authorCard'

// 作者身份卡的清洗规则单测：
// 这一层的失败只会让"简介/领域"显示不出来，不会弄坏 feed ——
// 所以这里的重点不是穷举异常，而是锁住「脏数据一律降级为空」这条底线。

const UID = '11111111-2222-3333-4444-555555555555'
const UID2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('normalizeAuthorCard', () => {
  it('正常行：原样带出简介与领域', () => {
    const card = normalizeAuthorCard({
      userId: UID,
      authorName: '阿吉',
      authorAvatarUrl: 'https://x/y.png',
      bio: '写商业分析，偏案例拆解',
      domains: ['商业分析', '商业分析', '职场'],
      postCount: 12,
    })
    expect(card).not.toBeNull()
    expect(card!.authorName).toBe('阿吉')
    expect(card!.bio).toBe('写商业分析，偏案例拆解')
    // 领域去重且保持顺序
    expect(card!.domains).toEqual(['商业分析', '职场'])
    expect(card!.postCount).toBe(12)
  })

  it('没有 userId 的行整条丢弃 —— 无法挂到任何作者身上', () => {
    expect(normalizeAuthorCard({ authorName: '幽灵' })).toBeNull()
    expect(normalizeAuthorCard(null)).toBeNull()
    expect(normalizeAuthorCard('x')).toBeNull()
  })

  it('字段缺失时降级而不是抛错：昵称兜底、简介为 null、领域为空数组', () => {
    const card = normalizeAuthorCard({ userId: UID })
    expect(card).not.toBeNull()
    expect(card!.authorName).toBe('创作者')
    expect(card!.bio).toBeNull()
    expect(card!.authorAvatarUrl).toBeNull()
    expect(card!.domains).toEqual([])
    expect(card!.postCount).toBe(0)
  })

  it('空白字符串不算简介 —— 否则卡片上会出现一条空白占位行', () => {
    const card = normalizeAuthorCard({ userId: UID, bio: '   ', authorAvatarUrl: '  ' })
    expect(card!.bio).toBeNull()
    expect(card!.authorAvatarUrl).toBeNull()
  })

  it('异常计数降级为 0，不出现 NaN', () => {
    expect(normalizeAuthorCard({ userId: UID, postCount: '很多' })!.postCount).toBe(0)
    expect(normalizeAuthorCard({ userId: UID, postCount: -3 })!.postCount).toBe(0)
  })
})

describe('missingAuthorIds', () => {
  const cache = new Map([[UID, { userId: UID } as never]])

  it('去重 + 过滤非法 id，且已有卡片的不再请求', () => {
    const ids = missingAuthorIds(Object.fromEntries(cache), [
      UID,
      UID,
      'not-a-uuid',
      UID2,
      UID2,
    ])
    expect(ids).toEqual([UID2])
  })

  it('缓存为空时返回全部合法 id，保持首次出现顺序', () => {
    expect(missingAuthorIds({}, [UID2, UID, 'x'])).toEqual([UID2, UID])
  })
})

// 这三个用例共享模块级缓存，顺序即场景：
// 先缓存 UID2，再验证「缓存命中 + 新请求」混合场景与失败场景。
describe('fetchAuthorCards', () => {
  const UID3 = '99999999-8888-7777-6666-555555555555'
  const UID4 = '12121212-3434-5656-7878-909090909090'

  const okResponse = (cards: unknown[]) =>
    ({ ok: true, json: async () => ({ cards }) }) as unknown as Response

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('缓存全部命中时依然返回卡片：调用方会拿返回值整块覆盖 state', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        return okResponse([{ userId: UID2, authorName: '小陈', bio: '写产品', domains: ['产品'], postCount: 3 }])
      })
    )

    const first = await fetchAuthorCards('tok', [UID2])
    expect(first[UID2]?.authorName).toBe('小陈')

    const second = await fetchAuthorCards('tok', [UID2])
    expect(calls).toBe(1) // 第二次走缓存，不再发请求
    // 关键断言：以前这里返回空对象，会把前几页已显示的简介/领域整片抹掉
    expect(second[UID2]?.authorName).toBe('小陈')
  })

  it('一部分来自缓存、一部分来自新请求时两者都返回', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse([{ userId: UID3, authorName: '老王' }]))
    )

    const cards = await fetchAuthorCards('tok', [UID2, UID3])
    expect(cards[UID2]?.authorName).toBe('小陈')
    expect(cards[UID3]?.authorName).toBe('老王')
  })

  it('请求失败不丢已有卡片：作者身份是增强信息，不该连带抹掉已显示的内容', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )

    const cards = await fetchAuthorCards('tok', [UID2, UID4])
    expect(cards[UID2]?.authorName).toBe('小陈')
    expect(cards[UID4]).toBeUndefined()
  })
})
