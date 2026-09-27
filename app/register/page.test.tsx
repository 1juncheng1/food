import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock supabase client(vi.hoisted 确保 mock 函数在 vi.mock 工厂执行时已定义)
const { mockSignUp, mockVerifyOtp, mockResend, mockSignOut } = vi.hoisted(() => ({
  mockSignUp: vi.fn(),
  mockVerifyOtp: vi.fn(),
  mockResend: vi.fn(),
  mockSignOut: vi.fn(),
}))

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      signUp: mockSignUp,
      verifyOtp: mockVerifyOtp,
      resend: mockResend,
      signOut: mockSignOut,
    },
  },
  // ⚠️ page.tsx 还从本模块 import 了这两个函数，mock 工厂必须一并导出。
  // 缺失时它们是 undefined，handleSendCode 一进错误分支就抛
  // "isAuthTransportError is not a function"，异常发生在 async 函数里未被捕获，
  // 表现为「错误文案不渲染 + resend 从未调用」，看起来像产品 bug，实为 mock 缺失。
  // （成功路径不调用它们，所以只有成功用例会通过——这个伪装很有迷惑性。）
  isAuthTransportError: (e: unknown) =>
    /fetch failed|failed to fetch|network|timeout|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(
      (e as { message?: string } | null)?.message ?? ''
    ),
  describeAuthError: (e: unknown) =>
    `网络异常:${(e as { message?: string } | null)?.message ?? ''}`,
}))

// 注册页已加已登录守卫(useAuth),默认未登录
vi.mock('@/components/auth-provider', () => ({
  useAuth: () => ({ session: null, user: null, loading: false }),
}))

// mock next/navigation router
const { mockPush, mockReplace } = vi.hoisted(() => ({ mockPush: vi.fn(), mockReplace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}))

import RegisterPage from './page'

describe('RegisterPage 注册流程 state machine', () => {
  beforeEach(() => {
    mockSignUp.mockReset()
    mockVerifyOtp.mockReset()
    mockResend.mockReset()
    mockSignOut.mockReset()
    mockPush.mockReset()
    mockReplace.mockReset()
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

  it('handleSendCode already_registered 且 resend 成功(未确认老用户):进入 code-sent,打破死结', async () => {
    const user = userEvent.setup()
    mockSignUp.mockResolvedValue({
      data: { session: null },
      error: { message: 'User already registered', code: 'user_already_registered' },
    })
    mockResend.mockResolvedValue({ data: {}, error: null })
    render(<RegisterPage />)
    await user.type(screen.getByLabelText('邮箱'), 'existing@example.com')
    await user.type(screen.getByLabelText('密码（至少6位）'), 'password123')
    await user.click(screen.getByRole('button', { name: /获取验证码/ }))

    // resend 被调用(重发确认码),并进入验证码步骤
    expect(mockResend).toHaveBeenCalledWith({ email: 'existing@example.com', type: 'signup' })
    expect(await screen.findByText(/验证码已发送/)).toBeInTheDocument()
    expect(screen.getAllByLabelText(/验证码第/)).toHaveLength(6)
  })

  it('handleSendCode already_registered 且 resend 失败(已确认用户):不切 step,中性文案', async () => {
    const user = userEvent.setup()
    mockSignUp.mockResolvedValue({
      data: { session: null },
      error: { message: 'User already registered', code: 'user_already_registered' },
    })
    mockResend.mockResolvedValue({
      data: null,
      error: { message: 'Email already confirmed', code: 'email_already_exists' },
    })
    render(<RegisterPage />)
    await user.type(screen.getByLabelText('邮箱'), 'existing@example.com')
    await user.type(screen.getByLabelText('密码（至少6位）'), 'password123')
    await user.click(screen.getByRole('button', { name: /获取验证码/ }))

    // 不进入 code-sent(无 OTP 输入),文案不暴露注册状态
    expect(screen.queryAllByLabelText(/验证码第/)).toHaveLength(0)
    expect(await screen.findByText(/已注册请直接登录|稍后重试/)).toBeInTheDocument()
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

  it('handleVerify 成功:调 verifyOtp 并 router.push /welcome', async () => {
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
    expect(mockPush).toHaveBeenCalledWith('/welcome')
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

  it('handleSendCode 邮箱格式非法(单字符 TLD):不调 signUp,显示格式错误', async () => {
    const user = userEvent.setup()
    mockSignUp.mockResolvedValue({ data: { session: null }, error: null })
    render(<RegisterPage />)
    await user.type(screen.getByLabelText('邮箱'), 'xxx@qq.c')
    await user.type(screen.getByLabelText('密码（至少6位）'), 'password123')
    await user.click(screen.getByRole('button', { name: /获取验证码/ }))

    expect(mockSignUp).not.toHaveBeenCalled()
    expect(await screen.findByText(/请输入正确的邮箱地址/)).toBeInTheDocument()
    expect(screen.queryAllByLabelText(/验证码第/)).toHaveLength(0)
  })

  it('handleSendCode 意外返回 session(email_confirm 未开启):清掉幽灵 session,不切 step', async () => {
    const user = userEvent.setup()
    mockSignUp.mockResolvedValue({ data: { session: { access_token: 'ghost' } }, error: null })
    mockSignOut.mockResolvedValue({ error: null })
    render(<RegisterPage />)
    await user.type(screen.getByLabelText('邮箱'), 'test@example.com')
    await user.type(screen.getByLabelText('密码（至少6位）'), 'password123')
    await user.click(screen.getByRole('button', { name: /获取验证码/ }))

    // 幽灵 session 必须被清掉,否则"去登录"会被 login 页已登录守卫直接放行进 dashboard
    expect(mockSignOut).toHaveBeenCalled()
    expect(await screen.findByText(/注册服务暂不可用|联系管理员/)).toBeInTheDocument()
    expect(screen.queryAllByLabelText(/验证码第/)).toHaveLength(0)
  })

  it('code-sent 步骤:不显示"去登录"链接(降低干扰,idle 步骤保留)', async () => {
    const user = userEvent.setup()
    mockSignUp.mockResolvedValue({ data: { session: null }, error: null })
    render(<RegisterPage />)
    expect(screen.getByRole('link', { name: '去登录' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('邮箱'), 'test@example.com')
    await user.type(screen.getByLabelText('密码（至少6位）'), 'password123')
    await user.click(screen.getByRole('button', { name: /获取验证码/ }))
    await screen.findByText(/验证码已发送/)

    expect(screen.queryByRole('link', { name: '去登录' })).not.toBeInTheDocument()
  })
})
