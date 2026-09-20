import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock supabase client(vi.hoisted 确保 mock 函数在 vi.mock 工厂执行时已定义)
const { mockSignUp, mockVerifyOtp, mockResend } = vi.hoisted(() => ({
  mockSignUp: vi.fn(),
  mockVerifyOtp: vi.fn(),
  mockResend: vi.fn(),
}))

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      signUp: mockSignUp,
      verifyOtp: mockVerifyOtp,
      resend: mockResend,
    },
  },
}))

// mock next/navigation router
const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

import RegisterPage from './page'

describe('RegisterPage 注册流程 state machine', () => {
  beforeEach(() => {
    mockSignUp.mockReset()
    mockVerifyOtp.mockReset()
    mockResend.mockReset()
    mockPush.mockReset()
  })

  it('初始渲染(idle 步骤):显示邮箱、密码、"获取验证码并注册"按钮', () => {
    render(<RegisterPage />)
    expect(screen.getByLabelText('邮箱')).toBeInTheDocument()
    expect(screen.getByLabelText('密码（至少6位）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /获取验证码/ })).toBeInTheDocument()
    // 未显示 OTP 输入
    expect(screen.queryAllByLabelText(/验证码第/)).toHaveLength(0)
  })

  it('handleSendCode 成功:进入 code-sent 步骤,显示"验证码已发送"和 OTP 输入', async () => {
    const user = userEvent.setup()
    mockSignUp.mockResolvedValue({ data: { session: null }, error: null })
    render(<RegisterPage />)
    await user.type(screen.getByLabelText('邮箱'), 'test@example.com')
    await user.type(screen.getByLabelText('密码（至少6位）'), 'password123')
    await user.click(screen.getByRole('button', { name: /获取验证码/ }))

    expect(mockSignUp).toHaveBeenCalledWith({
      email: 'test@example.com',
      password: 'password123',
    })
    expect(await screen.findByText(/验证码已发送/)).toBeInTheDocument()
    expect(screen.getAllByLabelText(/验证码第/)).toHaveLength(6)
  })

  it('handleSendCode user_already_registered:不切 step,显示枚举防护文案', async () => {
    const user = userEvent.setup()
    mockSignUp.mockResolvedValue({
      data: { session: null },
      error: { message: 'User already registered', code: 'user_already_registered' },
    })
    render(<RegisterPage />)
    await user.type(screen.getByLabelText('邮箱'), 'existing@example.com')
    await user.type(screen.getByLabelText('密码（至少6位）'), 'password123')
    await user.click(screen.getByRole('button', { name: /获取验证码/ }))

    // 不进入 code-sent(无 OTP 输入)
    expect(screen.queryAllByLabelText(/验证码第/)).toHaveLength(0)
    // 显示枚举防护文案(不暴露"已注册")
    expect(await screen.findByText(/已注册|直接登录|已发送/)).toBeInTheDocument()
  })

  it('handleSendCode rate_limit_exceeded:显示"请稍后再试"', async () => {
    const user = userEvent.setup()
    mockSignUp.mockResolvedValue({
      data: { session: null },
      error: { message: 'Rate limit exceeded', code: 'rate_limit_exceeded' },
    })
    render(<RegisterPage />)
    await user.type(screen.getByLabelText('邮箱'), 'test@example.com')
    await user.type(screen.getByLabelText('密码（至少6位）'), 'password123')
    await user.click(screen.getByRole('button', { name: /获取验证码/ }))

    expect(await screen.findByText(/请稍后再试/)).toBeInTheDocument()
    expect(screen.queryAllByLabelText(/验证码第/)).toHaveLength(0)
  })

  it('handleVerify 成功:调 verifyOtp 并 router.push /dashboard', async () => {
    const user = userEvent.setup()
    mockSignUp.mockResolvedValue({ data: { session: null }, error: null })
    mockVerifyOtp.mockResolvedValue({ data: { session: {} }, error: null })
    render(<RegisterPage />)
    await user.type(screen.getByLabelText('邮箱'), 'test@example.com')
    await user.type(screen.getByLabelText('密码（至少6位）'), 'password123')
    await user.click(screen.getByRole('button', { name: /获取验证码/ }))

    // 输入 OTP 012345
    const otpInputs = await screen.findAllByLabelText(/验证码第/)
    for (let i = 0; i < 6; i++) {
      await user.type(otpInputs[i], String(i))
    }
    await user.click(screen.getByRole('button', { name: /验证并注册/ }))

    expect(mockVerifyOtp).toHaveBeenCalledWith({
      email: 'test@example.com',
      token: '012345',
      type: 'signup',
    })
    expect(mockPush).toHaveBeenCalledWith('/dashboard')
  })

  it('handleVerify invalid_otp:显示"验证码错误",不跳转', async () => {
    const user = userEvent.setup()
    mockSignUp.mockResolvedValue({ data: { session: null }, error: null })
    mockVerifyOtp.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid OTP', code: 'invalid_otp' },
    })
    render(<RegisterPage />)
    await user.type(screen.getByLabelText('邮箱'), 'test@example.com')
    await user.type(screen.getByLabelText('密码（至少6位）'), 'password123')
    await user.click(screen.getByRole('button', { name: /获取验证码/ }))

    const otpInputs = await screen.findAllByLabelText(/验证码第/)
    for (let i = 0; i < 6; i++) {
      await user.type(otpInputs[i], String(i))
    }
    await user.click(screen.getByRole('button', { name: /验证并注册/ }))

    expect(await screen.findByText(/验证码错误/)).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('handleVerify otp_expired:显示"验证码已过期,请重新获取"', async () => {
    const user = userEvent.setup()
    mockSignUp.mockResolvedValue({ data: { session: null }, error: null })
    mockVerifyOtp.mockResolvedValue({
      data: { session: null },
      error: { message: 'OTP expired', code: 'otp_expired' },
    })
    render(<RegisterPage />)
    await user.type(screen.getByLabelText('邮箱'), 'test@example.com')
    await user.type(screen.getByLabelText('密码（至少6位）'), 'password123')
    await user.click(screen.getByRole('button', { name: /获取验证码/ }))

    const otpInputs = await screen.findAllByLabelText(/验证码第/)
    for (let i = 0; i < 6; i++) {
      await user.type(otpInputs[i], String(i))
    }
    await user.click(screen.getByRole('button', { name: /验证并注册/ }))

    expect(await screen.findByText(/验证码已过期/)).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })
})
