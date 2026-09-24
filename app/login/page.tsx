'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase, describeAuthError } from '@/lib/supabaseClient'
import { useAuth } from '@/components/auth-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function LoginPage() {
  const router = useRouter()
  const { session, loading: authLoading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  // 读取注册页跳转携带的提示信息（如"请检查邮箱完成注册"）
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get('message')
    if (m) setMessage(m)
  }, [])

  // 已登录用户直接跳转 dashboard（由 AuthProvider 统一管理 session 状态）
  useEffect(() => {
    if (!authLoading && session) {
      router.replace('/dashboard')
    }
  }, [authLoading, session, router])

  // AuthProvider 鉴权中：显示加载态，避免已登录用户看到表单闪烁
  if (authLoading) {
    return (
      <div className="inner-page gen-stage flex items-center justify-center" data-mode="inspiration">
        <div className="animate-pulse text-zinc-600 text-sm">加载中…</div>
      </div>
    )
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      // 原始 message 常是 "Failed to fetch" 这类英文传输错误：网络不通时用户会以为
      // 账号出问题。统一翻译成人话，并明确指向网络。
      setError(describeAuthError(error))
      setLoading(false)
      return
    }

    // 移除 router.refresh()：push 已完成导航，refresh 会触发多余的服务端组件全量刷新
    setLoading(false)
    router.push('/dashboard')
  }

  return (
    <div className="inner-page gen-stage flex items-center justify-center p-4" data-mode="inspiration">
      <div className="glass w-full max-w-md rounded-2xl p-8">
        <h1 className="text-2xl font-bold text-white mb-2">登录</h1>
        <p className="text-zinc-400 text-sm mb-6">登录你的视界账号</p>

        {message && (
          <div className="bg-indigo-500/10 text-indigo-300 text-sm rounded-lg p-3 mb-4">
            {message}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
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
            <label className="block text-sm text-zinc-400 mb-2">密码</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
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
            {loading ? '登录中...' : '登录'}
          </Button>
        </form>

        <p className="text-sm text-zinc-500 mt-6 text-center">
          还没有账号？{' '}
          <Link href="/register" className="text-indigo-400 hover:underline">
            去注册
          </Link>
        </p>
      </div>
    </div>
  )
}
