'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function RegisterPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    // 如果邮箱验证已关闭，signUp 会直接返回 session，可以自动登录
    if (data.session) {
      // 移除 router.refresh()：push 已完成导航，refresh 会触发多余的服务端组件全量刷新
      setLoading(false)
      router.push('/dashboard')
    } else {
      // 如果开启了邮箱验证，提示用户去邮箱确认
      setLoading(false)
      router.push('/login?message=请检查邮箱完成注册')
    }
  }

  return (
    <div className="inner-page gen-stage flex items-center justify-center p-4" data-mode="inspiration">
      <div className="glass w-full max-w-md rounded-2xl p-8">
        <h1 className="text-2xl font-bold text-white mb-2">注册</h1>
        <p className="text-zinc-400 text-sm mb-6">创建你的视界账号</p>

        <form onSubmit={handleRegister} className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-2">邮箱</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-2">密码（至少6位）</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="bg-red-500/10 text-red-400 text-sm rounded-lg p-3">
              {error}
            </div>
          )}

          <Button
            type="submit"
            disabled={loading}
            className="w-full"
          >
            {loading ? '注册中...' : '注册'}
          </Button>
        </form>

        <p className="text-sm text-zinc-500 mt-6 text-center">
          已有账号？{' '}
          <Link href="/login" className="text-indigo-400 hover:underline">
            去登录
          </Link>
        </p>
      </div>
    </div>
  )
}
