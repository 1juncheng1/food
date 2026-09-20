# ADR 0001: Reuse Supabase Native Email OTP for Registration Verification

Status: Accepted
Date: 2026-09-20

## Context

项目"视界 Vision"使用 Supabase managed auth(`auth.users` 托管用户表、密码哈希、会话)。当前注册流程在 `app/register/page.tsx` 中直接调用 `supabase.auth.signUp({ email, password })`,由于 Supabase 项目级 email_confirm 未开启,任何不存在/不属于自己的邮箱可立即获得 session 完成注册,存在邮箱未验证的安全风险。

需求要求升级注册流程,要求用户输入邮箱→发送验证码→输入验证码→验证邮箱所有权→创建正式账号→自动登录,并附带 6 位数字/5 分钟有效/一次性使用/60s 冷却/邮箱+IP 频率限制/5 次错误失效/不明文存储/不返回前端等一系列安全要求。

审计发现:Supabase 原生 Auth 已内置满足上述全部安全要求的 Email OTP 能力(`supabase.auth.verifyOtp` + `resend` + Dashboard 配置项)。

## Decision

**复用 Supabase 原生 Email OTP,不自建 `EmailVerificationCode` 表和 `EmailVerificationService`。**

具体做法:

1. Supabase Dashboard → Authentication → Email → 开启 "Confirm email"
2. Supabase Dashboard → Authentication → Email → "Confirmation OTP" 设为 numeric 6 位数字(非 magic link)
3. 生产环境在 Supabase Dashboard → Authentication → SMTP Settings 配置第三方 SMTP
4. 改造 `app/register/page.tsx`:新增 OTP 输入字段、获取验证码按钮(60s 倒计时)、错误码 → 文案映射、调用 `verifyOtp({ email, token, type: 'signup' })`
5. 验证成功后由 `verifyOtp` 返回的 session 自动登录,跳转 `/dashboard`

不引入 nodemailer/Resend/SendGrid 等邮件 Provider SDK 到代码库,不自实现 hash/限流/并发防护/IP 封禁。

## Consequences

- **正面**:
  - 零数据库迁移、零新表、零新依赖
  - 6 位数字/5 分钟/一次性/60s 冷却/邮箱+IP 频率限制/5 次错误失效 全部由 Supabase 原生承担
  - 验证码 hash 存储由 Supabase 内部负责,不接触明文
  - 历史用户兼容几乎免费(`email_confirmed_at` 字段已存在,补齐 SQL 即可)
  - 与现有 Supabase Auth 完全一致,不引入第二套认证机制
  - 未来扩展 LOGIN/RESET_PASSWORD/CHANGE_EMAIL 验证码可复用同一套机制

- **负面 / tradeoff**:
  - 限流参数(邮箱 10 分钟 5 次 / IP 10 分钟 10 次)由 Supabase Dashboard 控制,不能精确版本化,需在 runbook 记录
  - 生产环境必须配置第三方 SMTP,否则用户收不到邮件(开发环境可用 Supabase 默认邮件 3 封/小时配额)
  - Supabase Dashboard 配置项不能进 git,部署到新环境需手动重配
  - OTP 邮件模板定制受限于 Supabase 邮件模板编辑器(若需深度品牌化,需走 Supabase 自定义邮件模板)
  - 自建方案的部分可观测性(如自建表可查询验证码发送历史)需通过 Supabase Dashboard → Auth → Users 查看

- **后续约束**:
  - 任何未来要修改 OTP 行为(有效期/错误次数/限流)的需求,优先评估是否可在 Supabase Dashboard 配置,而非自建
  - 自定义 SMTP Provider 的密钥只能存在服务端环境变量(Supabase Dashboard 加密存储),禁止进 git/前端
  - 若未来需要 Supabase 不支持的高级定制(如多语言邮件/动态模板/A/B 测试),考虑自建,届时需重新评估本 ADR
