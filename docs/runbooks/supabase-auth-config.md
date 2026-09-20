# Supabase Auth 配置 Runbook

> 本文档记录"注册邮箱验证码"功能所需的 Supabase Dashboard 配置项。
> Dashboard 配置不可版本化,部署新环境时必须手动执行本 runbook。

## 1. 开启 Email Confirmation(必做)

**路径**:Supabase Dashboard → Authentication → Email Templates → Confirm signup

**操作**:
1. 进入 Supabase Dashboard → Authentication → Providers → Email
2. 开启 "Confirm email" 开关
3. "Confirmation OTP" 选项:选择 **Numeric 6 digits**(非 Magic Link)
4. 保存

**验证**:
- 调用 `supabase.auth.signUp({ email, password })` 后响应 `session: null`(待确认状态)
- 邮箱收到 6 位数字 OTP

## 2. 限流参数(建议配置)

**路径**:Supabase Dashboard → Authentication → Rate Limits

| 参数 | 建议值 | 说明 |
|---|---|---|
| Email OTP 发送冷却 | 60s | 同一邮箱 60 秒内不能重复发送 |
| 邮箱频率限制 | 5 次/10 分钟 | 超过则 rate_limit_exceeded |
| IP 频率限制 | 10 次/10 分钟 | 超过则拒绝 |
| OTP 错误次数 | 5 次 | 连续错误 5 次后 OTP 失效 |

> 注:Supabase Dashboard 限流参数名称可能随版本变化,以实际界面为准。
> 若 Dashboard 不支持精确数值,接受 Supabase 默认值(通常更严格)。

## 3. SMTP 配置

### 开发环境

开发环境**无需配置 SMTP**,使用 Supabase 默认邮件服务:
- 配额:3 封/小时/项目
- 发件人:noreply@mail.app.supabase.com
- 适合本地开发测试

**调试技巧**:
- Supabase Dashboard → Authentication → Users 可查看注册用户 + email_confirmed_at
- Supabase Dashboard → Authentication → Logs 可查看 OTP 发送/验证日志
- 测试时用同一邮箱重复注册,注意配额限制

### 生产环境(必做)

**阻塞生产部署。** 生产环境必须配置自定义 SMTP,否则用户收不到邮件。

**推荐 Provider:Resend**

1. 注册 Resend 账号:https://resend.com
2. 创建 API Key
3. 配置发件域名(验证 DNS 记录)
4. Supabase Dashboard → Authentication → SMTP Settings:
   - 开启 "Custom SMTP"
   - Host: `smtp.resend.com`
   - Port: `465`
   - Username: `resend`(固定值)
   - Password: `<Resend API Key>`
   - Sender email: `noreply@<你的已验证域名>`
   - Minimum interval: `60s`
   - Maximum frequency: `5 per 10 minutes`
5. 保存并测试发送

**备选 Provider**:
- SendGrid
- 腾讯云邮件推送
- 阿里云邮件推送

> **安全要求**:SMTP 密钥只能存在 Supabase Dashboard(加密存储),禁止进 git/前端/环境变量文件。

## 4. 历史用户兼容(可选,按需执行)

开启 Email Confirmation 后,`auth.users.email_confirmed_at` 为 null 的老用户可能登录受阻。

**检查**:
```sql
select count(*) from auth.users where email_confirmed_at is null;
```

**补齐 SQL**(仅当登录受阻时执行,需 service_role):

```sql
-- 将 cutoff 之前注册的老用户全部标记为已确认
update auth.users
set email_confirmed_at = now()
where email_confirmed_at is null
  and created_at < '2026-09-20';
```

**执行方式**:
- Supabase Dashboard → SQL Editor → 粘贴执行
- 或通过 service_role 客户端执行

## 5. 部署前检查清单

部署"注册邮箱验证码"功能前,逐项确认:

- [ ] Supabase Dashboard "Confirm email" 已开启
- [ ] "Confirmation OTP" 设为 Numeric 6 digits
- [ ] 限流参数已配置(60s 冷却 / 5 次邮箱 / 10 次 IP / 5 次错误)
- [ ] 生产环境 SMTP 已配置(Resend 推荐)
- [ ] SMTP 测试邮件发送成功
- [ ] 历史用户 `email_confirmed_at` 为 null 的数量已检查
- [ ] (如需)历史用户补齐 SQL 已执行
- [ ] `/register` 页面冒烟测试:输入邮箱+密码→点击获取验证码→收到 OTP→输入→跳转 `/dashboard`
- [ ] `/login` 页面回归测试:老用户登录正常

## 6. 故障排查

| 症状 | 排查方向 |
|---|---|
| signUp 后未收到邮件 | 检查 Supabase Dashboard → Auth → Logs;开发环境检查配额(3 封/小时) |
| verifyOtp 返回 otp_expired | OTP 已超 5 分钟,用户需重新获取 |
| verifyOtp 返回 invalid_otp | 用户输入错误,5 次后该 OTP 失效 |
| signUp 返回 rate_limit_exceeded | 60s 内重复发送或邮箱/IP 超频,等待冷却 |
| 老用户无法登录 | 检查 `email_confirmed_at`,执行补齐 SQL |
| 生产环境邮件延迟 | 检查 SMTP Provider 状态(Resend Dashboard → Logs) |
