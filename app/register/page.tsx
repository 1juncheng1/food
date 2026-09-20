'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCountdown } from '@/hooks/use-countdown'
import { OtpInput } from '@/components/auth/otp-input'

type Step = 'idle' | 'code-sent'

export default function RegisterPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const countdown = useCountdown(60)

  // 步骤 1:发送验证码(signUp 触发 Supabase 发送 OTP 邮件)
  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error } = await supabase.auth.signUp({ email, password })
    setLoading(false)

    if (error) {
      // 邮箱枚举防护:user_already_registered 不暴露"已注册",统一文案
      if (error.code === 'user_already_registered' || /already registered/i.test(error.message)) {
        setError('如该邮箱未注册,验证码已发送;已注册请直接登录')
      } else if (error.code === 'rate_limit_exceeded' || /rate limit/i.test(error.message)) {
        setError('请求过于频繁,请稍后再试')
      } else {
        setError('邮件发送失败,请稍后重试')
      }
      return
    }

    // 成功:进入 code-sent 步骤,启动 60s 倒计时
    setStep('code-sent')
    setOtp('')
    countdown.start(60)
  }

  // 步骤 2:验证 OTP 完成注册
  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (otp.length !== 6) {
      setError('请输入完整的 6 位验证码')
      return
    }

    setLoading(true)
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: otp,
      type: 'signup',
    })
    setLoading(false)

    if (error) {
      if (error.code === 'otp_expired' || /expired/i.test(error.message)) {
        setError('验证码已过期,请重新获取')
      } else if (error.code === 'invalid_otp' || /invalid/i.test(error.message)) {
        setError('验证码错误')
      } else {
        setError(error.message)
      }
      return
    }

    // 成功:verifyOtp 返回 session,onAuthStateChange 会触发 AuthProvider 更新
    router.push('/dashboard')
  }

  // 重新发送验证码(受 60s 倒计时限制)
  const handleResend = async () => {
    if (countdown.isCounting) return // 60s 内 disabled,双保险
    setError('')

    const { error } = await supabase.auth.resend({ email, type: 'signup' })
    if (error) {
      if (/rate limit/i.test(error.message)) {
        setError('请求过于频繁,请稍后再试')
      } else {
        setError('邮件发送失败,请稍后重试')
      }
      return
    }

    setOtp('')
    countdown.start(60)
  }

  return (
    <div className="inner-page gen-stage flex items-center justify-center p-4" data-mode="inspiration">
      <div className="glass w-full max-w-md rounded-2xl p-8">
        <h1 className="text-2xl font-bold text-white mb-2">注册</h1>
        <p className="text-zinc-400 text-sm mb-6">创建你的视界账号</p>

        {step === 'idle' && (
          <form onSubmit={handleSendCode} className="space-y-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-2">邮箱</label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                aria-label="邮箱"
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
                aria-label="密码（至少6位）"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="bg-red-500/10 text-red-400 text-sm rounded-lg p-3">
                {error}
              </div>
            )}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? '发送中...' : '获取验证码并注册'}
            </Button>
          </form>
        )}

        {step === 'code-sent' && (
          <form onSubmit={handleVerify} className="space-y-4">
            <div className="bg-indigo-500/10 text-indigo-300 text-sm rounded-lg p-3">
              验证码已发送至 {email}
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-2">验证码</label>
              <OtpInput value={otp} onChange={setOtp} disabled={loading} />
            </div>

            {error && (
              <div className="bg-red-500/10 text-red-400 text-sm rounded-lg p-3">
                {error}
              </div>
            )}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? '验证中...' : '验证并注册'}
            </Button>

            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                onClick={handleResend}
                disabled={countdown.isCounting || loading}
                className="text-indigo-400 hover:underline disabled:text-zinc-500 disabled:no-underline"
              >
                {countdown.isCounting ? `${countdown.seconds}s 后重新发送` : '重新发送验证码'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep('idle')
                  setOtp('')
                  setError('')
                }}
                className="text-zinc-400 hover:underline"
              >
                修改邮箱
              </button>
            </div>
          </form>
        )}

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
