// 身份写入的边界：外链头像的协议白名单 + media 路径越权防护
// 这两处都是安全相关（XSS 协议 / 删他人文件），必须有断言。

import { describe, expect, it } from 'vitest'
import { isSafeAvatarUrl } from './authMetadata'
import { mediaPathFromUrl } from './storage'

const UID = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'

describe('isSafeAvatarUrl', () => {
  it('接受 http/https 链接', () => {
    expect(isSafeAvatarUrl('https://cdn.example.com/a.png')).toBe(true)
    expect(isSafeAvatarUrl('http://cdn.example.com/a.png')).toBe(true)
  })

  it('拒绝可执行协议（会被当 URL 渲染执行）', () => {
    expect(isSafeAvatarUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeAvatarUrl('data:text/html,<script>')).toBe(false)
    expect(isSafeAvatarUrl('vbscript:msgbox')).toBe(false)
  })

  it('拒绝非字符串 / 空串 / 超长', () => {
    expect(isSafeAvatarUrl(null)).toBe(false)
    expect(isSafeAvatarUrl(123)).toBe(false)
    expect(isSafeAvatarUrl('   ')).toBe(false)
    expect(isSafeAvatarUrl('https://x.com/' + 'a'.repeat(1000))).toBe(false)
  })
})

describe('mediaPathFromUrl', () => {
  const url = (uid: string, file: string) =>
    `https://proj.supabase.co/storage/v1/object/public/media/${uid}/${file}`

  it('同用户的对象 → 解析出可删路径', () => {
    expect(mediaPathFromUrl(url(UID, 'avatar-1.png'), UID)).toBe(`${UID}/avatar-1.png`)
  })

  it('别人的对象 → 拒绝（否则一个伪造 URL 就能删他人文件）', () => {
    expect(mediaPathFromUrl(url(OTHER, 'avatar-1.png'), UID)).toBeNull()
  })

  it('非 media 桶 / 空值 / 非法输入 → null', () => {
    expect(mediaPathFromUrl('https://evil.com/a.png', UID)).toBeNull()
    expect(mediaPathFromUrl(null, UID)).toBeNull()
    expect(mediaPathFromUrl('', UID)).toBeNull()
  })

  it('带查询参数也能正确截断', () => {
    expect(mediaPathFromUrl(`${url(UID, 'a.png')}?t=123`, UID)).toBe(`${UID}/a.png`)
  })
})
