import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { OtpInput } from './otp-input'

describe('OtpInput', () => {
  it('渲染指定数量的输入格(默认 6)', () => {
    render(<OtpInput value="" onChange={() => {}} />)
    expect(screen.getAllByLabelText(/验证码第/)).toHaveLength(6)
  })

  it('每格 maxLength=1 强制单字符', () => {
    render(<OtpInput value="" onChange={() => {}} />)
    screen.getAllByLabelText(/验证码第/).forEach((input) => {
      expect(input).toHaveAttribute('maxlength', '1')
    })
  })

  it('支持自定义 length', () => {
    render(<OtpInput value="" onChange={() => {}} length={4} />)
    expect(screen.getAllByLabelText(/验证码第/)).toHaveLength(4)
  })

  it('disabled 时所有 input 不可编辑', () => {
    render(<OtpInput value="" onChange={() => {}} disabled />)
    screen.getAllByLabelText(/验证码第/).forEach((input) => {
      expect(input).toBeDisabled()
    })
  })

  it('输入 1 个字符后自动聚焦下一格', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<OtpInput value="" onChange={onChange} />)
    const inputs = screen.getAllByLabelText(/验证码第/)
    inputs[0].focus()
    await user.type(inputs[0], '5')
    expect(onChange).toHaveBeenCalledWith('5')
    expect(inputs[1]).toHaveFocus()
  })

  it('粘贴整段 OTP 自动填充全部并触发 onChange', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<OtpInput value="" onChange={onChange} />)
    const inputs = screen.getAllByLabelText(/验证码第/)
    inputs[0].focus()
    await user.paste('123456')
    expect(onChange).toHaveBeenCalledWith('123456')
  })

  it('Backspace 在空格回退到上一格并删除其内容', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    // value="1":第 1 格有 '1',焦点在第 2 格(空)
    render(<OtpInput value="1" onChange={onChange} />)
    const inputs = screen.getAllByLabelText(/验证码第/)
    inputs[1].focus()
    await user.type(inputs[1], '{Backspace}')
    expect(onChange).toHaveBeenCalledWith('')
    expect(inputs[0]).toHaveFocus()
  })
})
