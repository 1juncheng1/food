import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { trackEvent } from '@/lib/creative/interest/eventTracker'

export const maxDuration = 60

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    if (!id || !UUID_PATTERN.test(id)) {
      return NextResponse.json({ error: '无效的文案 ID' }, { status: 400 })
    }

    const authHeader = req.headers.get('authorization')
    const token = authHeader?.split(' ')[1]
    if (!token) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    })

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser()

    if (userError || !user) {
      return NextResponse.json({ error: '用户验证失败' }, { status: 401 })
    }

    // 显式限定 user_id，即使 RLS 配置有误也不会误删他人数据
    const { error: deleteError } = await supabase
      .from('scripts')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)

    if (deleteError) {
      console.error('删除错误:', deleteError)
      return NextResponse.json({ error: '删除失败，请稍后重试' }, { status: 500 })
    }

    // M1：素材删除 = 中性撤回（剔除该素材此前的画像贡献，不记负分）。
    // target_id 是文本无外键，脚本行删除后事件照常可入账。
    await trackEvent(supabase, user.id, {
      type: 'material_delete',
      targetType: 'script',
      targetId: id,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('API 错误:', error)
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 })
  }
}
