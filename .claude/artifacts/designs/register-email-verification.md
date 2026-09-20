# register-email-verification Spec

> Status: ALIGNED
> Author: user
> Last updated: 2026-09-20

## Background

当前注册页 `app/register/page.tsx` 仅收集 email + password 后直接调用 `supabase.auth.signUp`,即使 Supabase 项目级 email_confirm 未开启,任何不存在/不属于自己的邮箱也可立即获得 session 完成注册。本次升级要求:只有完成邮箱验证码验证,才能完成新用户注册。不修改登录方式。

## In scope

- 启用 Supabase 原生 Email OTP(numeric 6 位数字)用于注册邮箱确认
- 改造 `app/register/page.tsx`:新增 OTP 输入字段、获取验证码按钮、60s 倒计时、错误/过期/超频文案映射
- 调用 `supabase.auth.verifyOtp({ email, token, type: 'signup' })` 完成邮箱所有权验证
- 验证成功后自动登录(verifyOtp 返回 session)
- 历史用户兼容:`email_confirmed_at` 为 null 的旧用户补齐 SQL(可选交付)
- 生产环境 SMTP Provider 配置(Resend 推荐,dev-plan 阶段确认)

## Out of scope

- 不实现 LOGIN / RESET_PASSWORD / CHANGE_EMAIL 验证码流程
- 不修改现有登录 API、登录页、登录逻辑
- 不自建 `EmailVerificationCode` 表、不自建 `EmailVerificationService`
- 不引入自建邮件 Provider(nodemailer/SMTP 自实现)、不自实现 hash、不自实现限流
- 不改 Supabase 之外的 session/JWT/cookie 机制

## Assumptions

- 项目使用 Supabase managed auth(`auth.users`),不自建用户表
- Supabase 项目当前 email_confirm 处于未开启或被绕过状态(待 Dashboard 核实)
- Supabase 原生 OTP 默认配置与用户原方案要求可能不完全匹配,需在 Dashboard 配置:
  - OTP 有效期:Supabase 默认值 → 调整为 5 分钟(如 Dashboard 支持)
  - 错误次数上限:Supabase 默认 5 次 → 满足原方案要求
  - 发送冷却:Supabase 默认 60s → 满足原方案要求
  - 邮箱/IP 频率限制:Supabase 默认值,生产环境配自定义 SMTP 后放宽
- 开发环境可用 Supabase 默认邮件服务(免费配额 3 封/小时)
- 生产环境必须配置自定义 SMTP(Supabase Dashboard → Auth → SMTP Settings)

## Solution

### 后端(零代码改造,仅 Supabase Dashboard 配置)

1. Supabase Dashboard → Authentication → Email → 开启 "Confirm email"
2. Supabase Dashboard → Authentication → Email → "Confirmation OTP" 选项设为 numeric 6 位数字(非 magic link)
3. (生产)Supabase Dashboard → Authentication → SMTP Settings → 配置 Resend/SendGrid SMTP
4. (可选)Supabase Dashboard → Auth → Rate Limits 调整 OTP 相关限制

### 前端(改造 `app/register/page.tsx`)

注册页字段从 2 个(email + password)变为 3 个(email + password + OTP code),流程:

```text
1. 用户输入 email + password
2. 点击"获取验证码"按钮
3. 前端调用 supabase.auth.signUp({ email, password }) → 返回 session=null(待确认)
4. 同时调用 supabase.auth.resend() 或依赖 signUp 自带发送 OTP 邮件
5. "获取验证码"按钮进入 60s 倒计时
6. 用户在邮箱收到 6 位数字 OTP
7. 用户在前端输入 OTP
8. 前端调用 supabase.auth.verifyOtp({ email, token, type: 'signup' })
9. 成功 → 返回 session → 跳转 /dashboard(自动登录)
10. 失败 → 根据 Supabase 错误码显示对应文案
```

### 前端错误码 → 文案映射

| Supabase 错误 | 文案 |
|---|---|
| `otp_expired` | 验证码已过期,请重新获取 |
| `invalid_otp` / `otp_invalid` | 验证码错误 |
| `rate_limit_exceeded`(发送) | 请稍后再试 |
| `user_already_registered` | 该邮箱已注册,请直接登录 |
| `email_invalid` | 邮箱格式错误 |
| 网络异常 | 网络异常,请稍后重试 |

### 历史用户兼容(可选交付)

执行 SQL(需 service_role):

```sql
update auth.users
set email_confirmed_at = now()
where email_confirmed_at is null
  and created_at < '<cutoff_date>';
```

仅当开启 email_confirm 后老用户登录受阻时执行。

## Edge cases & risks

| Category | Notes |
|---|---|
| 邮箱枚举 | `signUp` 返回 user_already_registered 时,文案不应明显暴露"此邮箱已注册"。建议统一返回"验证码已发送"(实际不发送),引导用户去邮箱 |
| 重复点击"获取验证码" | Supabase 原生 60s 发送冷却,前端按钮 disabled + 倒计时 |
| OTP 连续错误 | Supabase 默认 5 次后该 OTP 失效,需重新获取 |
| 网络异常/邮件发送失败 | `signUp`/`resend` 返回错误,前端捕获并显示"邮件发送失败,请稍后重试" |
| 刷新页面 | OTP 状态在 localStorage,刷新后丢失,需重新获取 |
| OTP 输入 UI 形式 | 6 个独立格子 vs 单 input,dev-plan 阶段决策(推荐 6 格子,UX 更佳) |
| Supabase 项目级配置不可版本化 | Dashboard 配置不进 git,需在 README/runbook 记录配置项 |
| 生产 SMTP 未配置 | 开发环境可用 Supabase 默认邮件(3 封/小时配额),生产必须配 SMTP 否则用户收不到邮件 |
| 历史用户 email_confirmed_at 为 null | 开启 email_confirm 后可能无法登录,需 SQL 补齐 |
| 开发环境调试 | Supabase Dashboard → Auth → Users 可查看已发送 OTP;或开启 sandbox 模式在日志查看 |
| 限流数字不完全匹配原方案 | Supabase Dashboard 可配,但默认值可能与原方案"10分钟5次邮箱/10次IP"不完全一致;生产 SMTP 配置后限制放宽 |

## Acceptance criteria

- AC-1: 访问 `/register`,页面包含 email + password + OTP code 三个输入字段
- AC-2: 输入有效 email + password 后点击"获取验证码",按钮进入 60s 倒计时且 disabled
- AC-3: Supabase Dashboard 已开启 "Confirm email" + numeric OTP 模式(配置项记录在 runbook)
- AC-4: 调用 `supabase.auth.signUp({ email, password })` 后返回 `session=null`(用户未确认状态)
- AC-5: 用户输入正确 OTP,调用 `supabase.auth.verifyOtp({ email, token, type: 'signup' })` 返回 session,前端跳转 `/dashboard`
- AC-6: 用户输入错误 OTP,前端显示"验证码错误",不跳转
- AC-7: OTP 过期时,前端显示"验证码已过期,请重新获取"
- AC-8: 60s 内重复点击"获取验证码",前端显示"请稍后再试"
- AC-9: 邮件发送失败时,前端显示"邮件发送失败,请稍后重试"
- AC-10: `/login` 页面、登录 API、老用户登录流程完全不变(回归测试通过)
- AC-11: 历史用户 `email_confirmed_at` 已填充的,开启 email_confirm 后登录不受影响
- AC-12: 历史用户 `email_confirmed_at` 为 null 的,执行补齐 SQL 后可正常登录(可选交付)
- AC-13: 生产环境 SMTP 已配置(部署前检查项)

## Open questions

- **OQ-1**: 生产环境 SMTP Provider 选型(Resend / SendGrid / 腾讯云 / 阿里云 / 自建 SMTP)
  - 推荐 Resend(SDK 最简、Next.js 生态友好)
  - 阻塞生产部署,不阻塞开发
  - 需决策人:用户
- **OQ-2**: OTP 输入 UI 形式(6 格子 vs 单 input)
  - 推荐 6 格子,UX 更佳但代码量稍多
  - dev-plan 阶段决策
- **OQ-3**: 是否需要开发环境 DEV_EMAIL_OTP 辅助(在日志/响应里返回 OTP)
  - Supabase 自带 sandbox 模式可查看 OTP,可能无需自建

## Core entities (ontology)

| Entity | Type | Key fields | Relationship |
|---|---|---|---|
| User | Supabase `auth.users` | id, email (unique), encrypted_password, email_confirmed_at, created_at | 1 个 User 对应 1 个 email |
| Registration OTP | Supabase 内置(非自建表) | email, token (6 digits), expires_at, attempts | 1 个 email 同时只 1 个 active OTP |

## Interview metadata

- Mode: --deep
- Waves: 2
- Final ambiguity: 13.7%
- Status: PASSED

### Clarity breakdown

| Dimension | Score | Weight | Weighted |
|---|---|---|---|
| Goal Clarity | 0.90 | 0.40 | 0.360 |
| Scope Clarity | 0.90 | 0.25 | 0.225 |
| AC Clarity | 0.75 | 0.25 | 0.188 |
| Context Clarity | 0.90 | 0.10 | 0.090 |
| **Ambiguity** | | | **13.7%** |

### Ontology convergence

- Wave 1: 1 stable (User), 3 new (EmailVerificationCode / EmailVerificationService / email_confirmed_at) — stability 25%
- Wave 2 (post 方案 A 决策): 2 stable (User, email_confirmed_at), 0 new — stability 100%
- Drift resolved: 用户原方案预设的 `EmailVerificationCode` / `EmailVerificationService` 实体在方案 A 下移除,改为复用 Supabase 原生 `verifyOtp` API
