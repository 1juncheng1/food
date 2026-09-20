// ============================================================
// storageOwner —— 浏览器本地内容数据的用户归属（第九阶段 P0 越权修复）
//
// 背景：作品/风格记忆/自定义身份存 localStorage，而 localStorage 按浏览器
// 共享、不随登录账号隔离——同一浏览器切换账号 B 会读到/删掉 A 的本地内容。
//
// 方案：所有内容型存储键按用户 id 分桶（baseKey#u:<userId>）。
// 当前用户由 AuthProvider 在会话恢复/变更时同步注入；游客（未登录）
// 落到持久匿名游客桶（u:guest:<id>），与登录用户桶严格隔离——
// 游客生成闭环的作品落盘依赖此桶，同时绝不回退到全局键、绝不串号。
// ============================================================

/** 当前归属命名空间；null = 尚未注入（AuthProvider 首次执行前短暂存在，读写短路） */
let ownerScope: string | null = null

/** 需要按用户隔离的历史遗留全局键（首次登录迁移用） */
const LEGACY_KEYS = ['generated_works', 'style_memory', 'custom_identities']
/** 旧数据迁移完成标记（全局只做一次，迁移给这台设备上首个登录的用户） */
const MIGRATION_DONE_KEY = '__user_scoped_storage_migrated'
/** 游客匿名归属 id（持久）：游客生成闭环的作品落盘依赖它（P0 修复） */
const GUEST_ID_KEY = '__storage_owner_guest_id'

/**
 * 游客命名空间：惰性生成持久匿名 id，同浏览器游客态稳定复用。
 * 背景：游客是灵感场核心转化入口（/generate、/article 白名单不设登录墙），
 * 若游客读写全部短路，生成链路 saveWork 会静默丢弃作品，/article 永远
 * 显示"文章不存在"。游客桶与登录用户桶严格隔离（u:guest:<id> ≠ u:<uid>），
 * 不引入跨账号串号；同一浏览器多个游客共用一个桶（localStorage 本就按浏览器隔离）。
 */
function guestScope(): string {
  try {
    let id = localStorage.getItem(GUEST_ID_KEY)
    if (!id) {
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      localStorage.setItem(GUEST_ID_KEY, id)
    }
    return `u:guest:${id}`
  } catch {
    // localStorage 不可用（隐私模式等）：退化为会话内临时桶，读写仍隔离，只是不持久
    return 'u:guest:ephemeral'
  }
}

/**
 * 把游客桶内容迁移进刚登录的用户桶。
 * 保守策略：用户桶为空才整体搬入（避免覆盖老用户已有内容）；
 * 非空则跳过——游客内容留在 guest 桶，退出登录后仍可见，不丢数据。
 */
function migrateGuestInto(scope: string): void {
  try {
    const from = guestScope()
    if (from === scope) return
    for (const base of LEGACY_KEYS) {
      const raw = localStorage.getItem(`${base}#${from}`)
      if (raw == null) continue
      const target = `${base}#${scope}`
      if (localStorage.getItem(target) != null) continue // 用户桶已有内容：不覆盖
      localStorage.setItem(target, raw)
      localStorage.removeItem(`${base}#${from}`)
    }
  } catch {
    // 迁移失败不影响登录主流程；游客桶仍在，退出后可找回
  }
}

/**
 * 设置当前存储归属。由 AuthProvider 在 getSession / onAuthStateChange 时调用。
 * 幂等：同一用户重复设置不触发任何操作；切换账号时后续读写自动落到新桶。
 * 游客（null）：落到持久游客桶——游客生成闭环的作品读写依赖此桶（P0 修复）。
 */
export function setStorageOwner(userId: string | null): void {
  const next = userId ? `u:${userId}` : guestScope()
  if (next === ownerScope) return
  // 登录/切换账号：先把游客桶搬入新用户桶（仅空桶时），避免"我刚才生成的作品没了"
  if (userId) migrateGuestInto(next)
  ownerScope = next
  if (userId) migrateLegacy(next)
}

/**
 * 把内容型 baseKey 解析为当前用户私有键。
 * 返回 null 表示归属未就绪，调用方必须按"空数据/放弃写入"处理，
 * 绝不允许退回读取全局键（否则又会跨账号泄露）。
 */
export function userScopedKey(baseKey: string): string | null {
  return ownerScope ? `${baseKey}#${ownerScope}` : null
}

/**
 * 历史无主键数据一次性迁移：旧版本所有本地内容都没有归属，无法区分原作者，
 * 只能迁移给这台设备上首个登录的用户（其云端数据另有 RLS 按 user_id 隔离，
 * 本地镜像归属仅影响首屏）。迁移完成后删除旧键并打标记，后续账号不再迁移。
 */
function migrateLegacy(scope: string): void {
  try {
    const done = localStorage.getItem(MIGRATION_DONE_KEY) === '1'
    for (const base of LEGACY_KEYS) {
      const raw = localStorage.getItem(base)
      if (raw == null) continue
      if (!done) {
        const target = `${base}#${scope}`
        // 目标桶已有数据（该用户曾用过新版本）时不覆盖
        if (localStorage.getItem(target) == null) {
          localStorage.setItem(target, raw)
        }
      }
      localStorage.removeItem(base)
    }
    if (!done) localStorage.setItem(MIGRATION_DONE_KEY, '1')
  } catch {
    // localStorage 不可用时静默（与各存储模块既有容错一致）
  }
}
