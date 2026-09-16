// ============================================================
// storageOwner —— 浏览器本地内容数据的用户归属（第九阶段 P0 越权修复）
//
// 背景：作品/风格记忆/自定义身份存 localStorage，而 localStorage 按浏览器
// 共享、不随登录账号隔离——同一浏览器切换账号 B 会读到/删掉 A 的本地内容。
//
// 方案：所有内容型存储键按用户 id 分桶（baseKey#u:<userId>）。
// 当前用户由 AuthProvider 在会话恢复/变更时同步注入；未注入（鉴权中/游客）
// 时一律视为"无数据"，读写全部短路，绝不回退到全局键，从根上杜绝串号。
// ============================================================

/** 当前登录用户的命名空间；null = 尚未注入（此时禁止任何内容读写） */
let ownerScope: string | null = null

/** 需要按用户隔离的历史遗留全局键（首次登录迁移用） */
const LEGACY_KEYS = ['generated_works', 'style_memory', 'custom_identities']
/** 旧数据迁移完成标记（全局只做一次，迁移给这台设备上首个登录的用户） */
const MIGRATION_DONE_KEY = '__user_scoped_storage_migrated'

/**
 * 设置当前存储归属。由 AuthProvider 在 getSession / onAuthStateChange 时调用。
 * 幂等：同一用户重复设置不触发任何操作；切换账号时后续读写自动落到新桶。
 */
export function setStorageOwner(userId: string | null): void {
  const next = userId ? `u:${userId}` : null
  if (next === ownerScope) return
  ownerScope = next
  if (next) migrateLegacy(next)
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
