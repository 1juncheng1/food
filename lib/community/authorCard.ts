// ============================================================
// 作者卡片：灵感广场 / 详情页共用的「这位创作者是谁」
//
// 数据来自 POST /api/community/author-cards（底层是 0010 迁移的
// public.get_author_cards）。之所以单独一层而不是跟着帖子回来：
//   1. 20 条帖子常常只有 6 个作者 —— 按 id 去重后一次取完，不跟着每行重复
//   2. 作者身份变化极慢（昵称/简介），会话级缓存即可，翻页不必再问服务端
//   3. 迁移没执行时这个接口 404/503 —— 降级为"没有简介"，绝不能拖垮广场
// ============================================================

export interface AuthorCard {
  userId: string
  authorName: string
  authorAvatarUrl: string | null
  bio: string | null
  /** 常用领域：取自作者已公开帖子的分类（最多 3 个） */
  domains: string[]
  postCount: number
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_IDS = 60

// ── 1. 纯函数（可单测） ─────────────────────────────────

function s(v: unknown, max: number): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''
}

/** 服务端 jsonb 行 → 类型化卡片（无效返回 null，交给调用方丢弃） */
export function normalizeAuthorCard(raw: unknown): AuthorCard | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const userId = s(o.userId, 64)
  if (!userId) return null

  const domains = Array.isArray(o.domains)
    ? Array.from(
        new Set((o.domains as unknown[]).filter((v): v is string => typeof v === 'string').map((v) => v.trim().slice(0, 40)).filter(Boolean))
      ).slice(0, 3)
    : []

  const count = Number(o.postCount)

  return {
    userId,
    authorName: s(o.authorName, 60) || '创作者',
    authorAvatarUrl: typeof o.authorAvatarUrl === 'string' && o.authorAvatarUrl.trim() ? o.authorAvatarUrl.trim() : null,
    bio: typeof o.bio === 'string' && o.bio.trim() ? o.bio.trim().slice(0, 300) : null,
    domains,
    postCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
  }
}

/**
 * 从帖子列表里挑出还没拿卡片的作者 id。
 * 自行排序去重：翻页时新旧 id 混在一起，顺序稳定才能让请求可预测。
 */
export function missingAuthorIds(
  cards: Record<string, AuthorCard>,
  userIds: readonly string[]
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of userIds) {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) continue
    if (cards[id] || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_IDS) break
  }
  return out
}

// ── 2. 会话级缓存 ─────────────────────────────────────

const cache = new Map<string, AuthorCard>()

/**
 * 批量取作者卡片，返回「本次可用的全部卡片」（含缓存）。
 *
 * 失败语义刻意宽松：这一层挂了只影响"作者信息有没有"，
 * 不该影响"广场能不能刷"。调用方拿不到就不展示，不打 error 面板。
 */
export async function fetchAuthorCards(
  token: string,
  userIds: readonly string[]
): Promise<Record<string, AuthorCard>> {
  const merged: Record<string, AuthorCard> = {}
  const known: Record<string, AuthorCard> = {}
  for (const [id, card] of cache) known[id] = card

  // ⚠ 返回值必须是「本次要展示的作者全部可用卡片」，不能只返回新取到的那部分：
  // 调用方拿返回值整块 setState。若缓存全部命中就返回空对象，翻到第 N 页时
  // 会把前几页已经显示出来的简介/领域一次性抹掉 —— 缓存越热，丢得越干净。
  // 先铺缓存，再补新取到的，才是最省请求又不闪信息的做法。
  for (const id of userIds) {
    if (typeof id !== 'string') continue
    const hit = known[id]
    if (hit) merged[id] = hit
  }

  const pending = missingAuthorIds(known, userIds)

  if (pending.length === 0) return merged

  try {
    const res = await fetch('/api/community/author-cards', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userIds: pending }),
    })
    if (!res.ok) return merged
    const data = (await res.json().catch(() => null)) as { cards?: unknown[] } | null
    const cards = Array.isArray(data?.cards) ? data.cards : []
    for (const row of cards) {
      const card = normalizeAuthorCard(row)
      if (!card) continue
      cache.set(card.userId, card)
      merged[card.userId] = card
    }
    // 请求了但服务端没返回 = 该作者确实没有更多身份信息，缓存空壳避免反复问
    for (const id of pending) {
      if (!cache.has(id)) cache.set(id, emptyCard(id))
    }
  } catch {
    // 网络抖动：保持已有镜像，下次自然补
  }
  return merged
}

/** 已问过但服务端没有更多身份信息的作者：存空壳，避免同一批 id 反复请求 */
function emptyCard(userId: string): AuthorCard {
  return {
    userId,
    authorName: '创作者',
    authorAvatarUrl: null,
    bio: null,
    domains: [],
    postCount: 0,
  }
}
