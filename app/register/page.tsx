'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase, describeAuthError, isAuthTransportError } from '@/lib/supabaseClient'
import { useAuth } from '@/components/auth-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCountdown } from '@/hooks/use-countdown'
import { OtpInput } from '@/components/auth/otp-input'

type Step = 'idle' | 'code-sent'

// 合法邮箱:要求 TLD ≥ 2 字符,挡住 "xxx@qq.c" 这类不存在域名的拼写
// (HTML5 type=email 只查语法,单字符 TLD 会被放过,邮件必然退信)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export default function RegisterPage() {
  const router = useRouter()
  const { session, loading: authLoading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [resending, setResending] = useState(false)
  const countdown = useCountdown(60)

  // 已登录用户访问 /register:与 /login 对称,统一走 /welcome。
  // 出口收敛到一处:/welcome 自己判断是否需要访谈,不需要就直接进 dashboard,
  // 避免"注册成功跳 A、已登录守卫跳 B"两个目标打架。
  useEffect(() => {
    if (!authLoading && session) router.replace('/welcome')
  }, [authLoading, session, router])

  if (authLoading) {
    return (
      <div className="inner-page flex items-center justify-center" data-mode="inspiration">
        <div className="animate-pulse text-[var(--vs-ink-4)] text-sm">加载中…</div>
      </div>
    )
  }

  // 进入验证码步骤的统一入口(新注册 signUp 成功 或 老的未确认用户 resend 成功)
  const enterCodeSent = () => {
    setStep('code-sent')
    setOtp('')
    countdown.start(60)
  }

  // 步骤 1:发送验证码(signUp 触发 Supabase 发送 OTP 邮件)
  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const trimmedEmail = email.trim()
    if (!EMAIL_RE.test(trimmedEmail)) {
      setError('请输入正确的邮箱地址')
      return
    }

    setLoading(true)
    const { data, error } = await supabase.auth.signUp({ email: trimmedEmail, password })
    setLoading(false)

    if (error) {
      // 网络不通时 signUp 直接失败（"Failed to fetch"）：必须明确告诉用户是网络问题，
      // 否则会被误解成"邮件发送失败"而反复重试
      if (isAuthTransportError(error)) {
        setError(describeAuthError(error))
        return
      }
      if (error.code === 'rate_limit_exceeded' || /rate limit/i.test(error.message)) {
        setError('请求过于频繁,请稍后再试')
        return
      }
      if (error.code === 'user_already_registered' || /already registered/i.test(error.message)) {
        // 该邮箱可能是"之前注册但没完成验证"的用户——Supabase 对这种用户会
        // 直接报 already_registered 且不发新码,导致用户永久卡死。
        // 静默尝试 resend:未确认用户会收到新码并进验证码步骤;已确认用户
        // resend 会报错,此时给中性文案引导去登录(不暴露邮箱是否注册)。
        setLoading(true)
        const { error: resendError } = await supabase.auth.resend({ email: trimmedEmail, type: 'signup' })
        setLoading(false)
        if (!resendError) {
          enterCodeSent()
          return
        }
        if (/rate limit/i.test(resendError.message)) {
          setError('请求过于频繁,请稍后再试')
        } else {
          setError('如该邮箱已注册请直接登录,未收到验证码请稍后重试')
        }
        return
      }
      setError('邮件发送失败,请稍后重试')
      return
    }

    // 防御:Supabase 未开启 email_confirm 时 signUp 会直接返回 session——
    // 邮箱未验证却已登录。立即清掉,否则"去登录"会被 login 页已登录守卫
    // 直接放行进 dashboard,整个 OTP 验证被绕过。
    if (data.session) {
      await supabase.auth.signOut({ scope: 'local' })
      setError('注册服务暂不可用(邮箱验证未正确配置),请联系管理员')
      return
    }

    // 成功:进入 code-sent 步骤,启动 60s 倒计时
    enterCodeSent()
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
      email: email.trim(),
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
        setError(describeAuthError(error))
      }
      return
    }

    // 成功:verifyOtp 返回 session,onAuthStateChange 会触发 AuthProvider 更新
    // 跳 /welcome 而不是 dashboard:注册后的第一件事是创作者访谈,
    // 已完成访谈的用户会在 /welcome 被直接送去 dashboard。
    router.push('/welcome')
  }

  // 重新发送验证码(受 60s 倒计时 + 请求飞行中防重入双重限制)
  const handleResend = async () => {
    if (countdown.isCounting || resending) return
    setError('')
    setResending(true)

    const { error } = await supabase.auth.resend({ email: email.trim(), type: 'signup' })
    setResending(false)

    if (error) {
      if (isAuthTransportError(error)) {
        setError(describeAuthError(error))
      } else if (error.code === 'rate_limit_exceeded' || /rate limit/i.test(error.message)) {
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
    <div className="inner-page flex items-center justify-center p-4" data-mode="inspiration">
      <div className="vs-frame w-full max-w-md rounded-2xl p-8">
        <h1 className="text-2xl font-bold text-[var(--vs-ink)] mb-2">注册</h1>
        <p className="vs-note mb-6">创建你的银河叙事账号</p>

        {step === 'idle' && (
          <form onSubmit={handleSendCode} className="space-y-4">
            <div>
              <label className="block text-[14px] mb-2 text-[var(--vs-ink-3)]">邮箱</label>
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
              <label className="block text-[14px] mb-2 text-[var(--vs-ink-3)]">密码（至少6位）</label>
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
              <div className="vs-error">
                {error}
              </div>
            )}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? '发送中...' : '获取验证码并注册'}
            </Button>

            <p className="vs-note pt-2 text-center">
              已有账号？{' '}
              <Link href="/login" className="text-[var(--vs-ink)] hover:underline">
                去登录
              </Link>
            </p>
          </form>
        )}

        {step === 'code-sent' && (
          <form onSubmit={handleVerify} className="space-y-4">
            <div className="vs-frame p-3 text-[14px]">
              验证码已发送至 {email}
            </div>
            <div>
              <label className="block text-[14px] mb-2 text-[var(--vs-ink-3)]">验证码</label>
              <OtpInput value={otp} onChange={setOtp} disabled={loading} />
            </div>

            {error && (
              <div className="vs-error">
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
                disabled={countdown.isCounting || loading || resending}
                className="text-[var(--vs-ink)] hover:underline disabled:text-[var(--vs-ink-4)] disabled:no-underline"
              >
                {resending
                  ? '发送中...'
                  : countdown.isCounting
                    ? `${countdown.seconds}s 后重新发送`
                    : '重新发送验证码'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep('idle')
                  setOtp('')
                  setError('')
                }}
                className="text-[var(--vs-ink-3)] hover:underline"
              >
                修改邮箱
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
