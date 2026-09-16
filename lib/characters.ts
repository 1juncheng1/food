// ============================================================
// 角色库（user_characters）—— 可跨作品复用的"故事角色"资产
//
// 与"创作身份"（identityTemplates）严格区分：
//   身份 = AI 用什么口吻写（影评人/科普博主）；角色 = 内容里登场的人物。
//
// 设计原则：
// 1. 生成请求传"快照"（CharacterSnapshot）而非 id：生成后修改角色库
//    不影响已生成作品的可复现性；
// 2. 服务端入参必须经 sanitizeCharacterInput 清洗（数量/长度/枚举白名单）；
// 3. 四层注入约束固化在 formatCharactersForPrompt，blueprint 与正文两处
//    共用同一份文本，禁止各自重写；
// 4. 不选角色时零污染：返回空串，prompt 不出现任何角色块。
// ============================================================

/** 角色定位：protagonist=主线视角 / supporting=适度出现 / narrator=第一人称叙述 */
export type CharacterRole = 'protagonist' | 'supporting' | 'narrator'

export const CHARACTER_ROLES: CharacterRole[] = ['protagonist', 'supporting', 'narrator']

export const CHARACTER_ROLE_LABELS: Record<CharacterRole, string> = {
  protagonist: '主角 · 主线视角',
  supporting: '配角 · 适度出现',
  narrator: '叙述者 · 第一人称',
}

export function isCharacterRole(v: unknown): v is CharacterRole {
  return typeof v === 'string' && (CHARACTER_ROLES as string[]).includes(v)
}

/** 角色库行（user_characters 表） */
export interface UserCharacter {
  id: string
  name: string
  background: string
  personality: string
  role: CharacterRole
  is_self: boolean
  created_at: string
  updated_at: string
}

/** 生成请求/作品记录用的角色快照（与库解耦） */
export interface CharacterSnapshot {
  name: string
  background: string
  personality: string
  role: CharacterRole
  isSelf: boolean
}

/** 每次生成最多登场角色数（控 prompt 长度与 token 成本） */
export const MAX_CHARACTERS_PER_GENERATION = 3

// ── 服务端清洗 ───────────────────────────────────────────────

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : ''
}

/** 清洗生成请求里的角色数组：最多 3 个；字段截断；role 白名单；无有效名字的丢弃 */
export function sanitizeCharacterInput(raw: unknown): CharacterSnapshot[] {
  if (!Array.isArray(raw)) return []
  const out: CharacterSnapshot[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = clean(o.name, 30)
    if (!name) continue
    if (out.some((c) => c.name === name)) continue // 同名去重
    const role: CharacterRole = isCharacterRole(o.role) ? o.role : 'supporting'
    out.push({
      name,
      background: clean(o.background, 200),
      personality: clean(o.personality, 200),
      role,
      isSelf: o.isSelf === true,
    })
    if (out.length >= MAX_CHARACTERS_PER_GENERATION) break
  }
  return out
}

// ── 注入文本（四层约束，blueprint 与正文共用） ────────────────

/** 生成 prompt 的角色块 + 证据用快照；空数组返回空串（零污染） */
export function formatCharactersForPrompt(list: CharacterSnapshot[]): {
  text: string
  used: { name: string; role: CharacterRole; isSelf: boolean }[]
} {
  if (list.length === 0) return { text: '', used: [] }

  const lines: string[] = []
  lines.push('【登场角色设定（本篇内容必须使用以下角色，硬性约束）】')
  lines.push('四层约束（违反任何一条即为不合格产出）：')
  lines.push('1. 身份层：角色的名字、背景、性格设定必须原样采用，禁止改名、禁止改编核心设定；')
  lines.push('2. 一致性层：角色的言行、决策、说话方式必须符合其性格设定；')
  lines.push('3. 戏份层：严格按角色定位分配戏份，不得让配角抢占主线；')
  lines.push(
    '4. 边界层：标记为"用户本人"的角色，其背景之外的细节一律不得虚构为该用户的真实经历，故事化扩充需自然融入设定而非编造新"事实"。'
  )

  list.forEach((c, i) => {
    const roleText =
      c.role === 'protagonist'
        ? '主角（全篇主线视角，戏份最重）'
        : c.role === 'narrator'
          ? '叙述者（第一人称"我"叙述全篇）'
          : '配角（适度出现，服务主线）'
    const selfTag = c.isSelf ? '〔这是用户本人的化身，格外谨慎对待"真实经历"边界〕' : ''
    lines.push(
      `${i + 1}. ${c.name}｜定位：${roleText}${selfTag}\n   背景：${c.background || '（未提供，允许合理虚构，但不得标注为用户真实经历）'}\n   性格与说话方式：${c.personality || '（未提供，按角色定位自然把握）'}`
    )
  })

  return {
    text: `\n\n${lines.join('\n')}`,
    used: list.map((c) => ({ name: c.name, role: c.role, isSelf: c.isSelf })),
  }
}
