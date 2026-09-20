# register-email-verification Implementation Plan

> Status: APPROVED
> Source: .claude/artifacts/designs/register-email-verification.md (status=ALIGNED)
> Mode: --deliberate
> Iterations: 2 / 3
> Author: user
> Last updated: 2026-09-20

## Requirements summary

升级 `app/register/page.tsx` 注册流程,从"输入邮箱+密码→直接 signUp"改为"输入邮箱+密码→发送 OTP→输入 OTP→verifyOtp→自动登录"。复用 Supabase 原生 Email OTP,不自建表不自建 Service。不修改登录流程。

## Acceptance criteria

(继承自 spec,共 13 条,详见 source spec)

- AC-1: `/register` 页面包含 email + password + OTP code 三个输入字段
- AC-2: 点击"获取验证码"后按钮进入 60s 倒计时且 disabled
- AC-3: Supabase Dashboard 已开启 "Confirm email" + numeric OTP(runbook 记录)
- AC-4: `signUp({ email, password })` 返回 `session=null`
- AC-5: 正确 OTP → `verifyOtp({ email, token, type: 'signup' })` 返回 session → 跳 `/dashboard`
- AC-6: 错误 OTP → 显示"验证码错误",不跳转
- AC-7: OTP 过期 → 显示"验证码已过期,请重新获取"
- AC-8: 60s 内重复点击 → 显示"请稍后再试"
- AC-9: 邮件发送失败 → 显示"邮件发送失败,请稍后重试"
- AC-10: `/login` 页/API/老用户登录流程完全不变
- AC-11: `email_confirmed_at` 已填充的老用户登录不受影响
- AC-12: `email_confirmed_at` 为 null 的老用户执行补齐 SQL 后可登录(可选)
- AC-13: 生产环境 SMTP 已配置(部署前检查)

## RALPLAN-DR

### Principles

1. **复用优先**:Supabase 原生能力覆盖全部安全要求,不自建(ADR 0001 已决策)
2. **最小代码**:前端改造为主,零后端 API 路由,零新依赖
3. **外科手术式改动**:只改 `app/register/page.tsx` + 新增 1 个 OTP 组件 + 1 个倒计时 hook + 1 个 runbook 文档
4. **不破坏登录**:`/login` 页/API/老用户登录流程零改动
5. **可验证**:13 条 AC 全部二值可验证,17 个测试场景可执行

### Decision drivers

1. **上线时间**(高):前端改造 + Dashboard 配置即可上线,无需后端开发
2. **维护成本**(高):零新表零新依赖,长期维护成本极低
3. **安全合规**(高):Supabase 原生覆盖 spec 全部安全要求
4. **用户体验**(中):注册转化率不应显著下降,两步式 UX 需清晰
5. **生产 SMTP 可用性**(中,阻塞生产):开发可用 Supabase 默认邮件,生产必须配 SMTP

### Viable options

**Option A: 单页 state machine + 前端直调 Supabase**

- 实现思路:`app/register/page.tsx` 内部用 `step` state 切换(idle / code-sent / verified),前端直接调 `signUp` / `verifyOtp` / `resend`,无新增 API route
- 改动文件:`app/register/page.tsx`(主), `components/auth/otp-input.tsx`(新), `hooks/use-countdown.ts`(新), `docs/runbooks/supabase-auth-config.md`(新)
- Pros: 最小改动,零新 API route,零新抽象层,与现有 Supabase 客户端模式一致
- Cons: 单页内 state machine 稍复杂;前端直调 `resend` 暴露 Supabase 调用(但本就前端可见,无信息泄漏)

**Option B: 拆分两页 route + API route 代理**

- 实现思路:拆为 `/register`(email+password) → `/register/verify`(OTP 输入),新增 `app/api/auth/send-otp/route.ts` 和 `app/api/auth/verify-otp/route.ts` 代理 Supabase 调用,加服务端限流
- 改动文件:`app/register/page.tsx`, `app/register/verify/page.tsx`(新), `app/api/auth/send-otp/route.ts`(新), `app/api/auth/verify-otp/route.ts`(新), 复用 `lib/rateLimit.ts`
- Pros: UX 步骤清晰;服务端限流/日志/错误映射可控;可观测性更好
- Cons: 4 个新文件 + 1 个新 route,改动面大 2-3 倍;API route 代理 Supabase 调用是多余抽象(Supabase 已有限流);两页跳转增加用户流失

**Option C: 完全自建 OTP 服务**(已由 ADR 0001 拒绝,不再考虑)

**Invalidation rationale**:
- Option B 被砍原因:Supabase 原生已带 60s 发送冷却 + 邮箱/IP 频率限制 + 5 次错误失效,API route 代理层只是重复实现,徒增维护面;两页拆分增加用户流失风险;改动文件多 2-3 倍违反"最小代码"原则
- Option C 被 ADR 0001 拒绝

### Favored option: A

## Implementation steps

基于 Option A,融合 Architect 建议的两步式 state machine(单页内,不拆 route):

1. **新建倒计时 hook** — `hooks/use-countdown.ts:1-30`
   - 导出 `useCountdown(initialSec: number)` 返回 `{ seconds, isCounting, start }`
   - `start()` 触发 `setInterval` 每秒递减,到 0 停止
   - `useEffect` 清理 interval 防止内存泄漏
   - 用于 AC-2(60s 倒计时)

2. **新建 OTP 6 格子输入组件** — `components/auth/otp-input.tsx:1-80`
   - Props: `{ value: string; onChange: (v: string) => void; disabled?: boolean; length?: number }`
   - 6 个独立 `<input maxLength={1} inputMode="numeric" pattern="\d*" />`,自动聚焦下一格,粘贴整段 OTP 自动填充,Backspace 回退
   - 无障碍:`aria-label="验证码第 N 位"`,支持键盘 Tab 导航
   - 用于 AC-1(OTP 输入字段)

3. **改造 register 页 state machine** — `app/register/page.tsx:10-16`
   - 新增 state:`step: 'idle' | 'code-sent'`、`otp: string`、`countdown` 来自 hook
   - 保留:`email` / `password` / `error` / `loading`
   - step='idle':显示 email + password + "获取验证码并注册"按钮
   - step='code-sent':显示 email(只读) + OTP 6 格子 + "验证并注册"按钮 + "重新发送(60s)"按钮 + "修改邮箱"链接回 idle

4. **实现 handleSendCode** — `app/register/page.tsx` 新增函数
   - 校验 email 格式(基础 regex)+ password 长度 ≥ 6
   - 调 `supabase.auth.signUp({ email, password })`
   - 成功(无 error)→ step='code-sent', `countdown.start(60)`,显示"验证码已发送"
   - error 映射:`user_already_registered` → "该邮箱已注册,请直接登录"(不暴露枚举风险,但需引导用户);`rate_limit_exceeded` → "请稍后再试";其他 → 原始 message
   - 对应 AC-2 / AC-4 / AC-8 / AC-9

5. **实现 handleVerify** — `app/register/page.tsx` 新增函数
   - 校验 OTP 长度 = 6 且全数字
   - 调 `supabase.auth.verifyOtp({ email, token: otp, type: 'signup' })`
   - 成功 → `onAuthStateChange` 自动触发 AuthProvider 更新 session → `router.push('/dashboard')`
   - error 映射:`otp_expired` → "验证码已过期,请重新获取";`invalid_otp` → "验证码错误";`user_not_found` → "验证码已失效,请重新获取";其他 → 原始 message
   - 对应 AC-5 / AC-6 / AC-7

6. **实现 handleResend** — `app/register/page.tsx` 新增函数
   - 检查 `countdown.isCounting`,true 则直接 return(disabled 状态本应阻止点击,双保险)
   - 调 `supabase.auth.resend({ email, type: 'signup' })`
   - 成功 → `countdown.start(60)`,显示"验证码已重新发送"
   - error → 显示对应文案
   - 对应 AC-8

7. **改造 register 页 JSX** — `app/register/page.tsx:45-97`
   - step='idle':保留现有 email + password 字段,提交按钮文案改为"获取验证码并注册",`onSubmit={handleSendCode}`
   - step='code-sent':渲染 `<OtpInput>` + "验证并注册"按钮(`onSubmit={handleVerify}`) + "重新发送"按钮(`onClick={handleResend}` disabled={countdown.isCounting}) + "修改邮箱"链接(setStep('idle'))
   - error 提示区保留

8. **新建 Supabase 配置 runbook** — `docs/runbooks/supabase-auth-config.md:1-60`
   - 章节:Email Confirm 开启 / OTP numeric 6 位 / SMTP 配置(开发用默认,生产用 Resend)/ 限流参数 / 历史用户补齐 SQL / 部署前检查清单
   - 对应 AC-3 / AC-13

9. **(可选)历史用户兼容 SQL** — `supabase/migrations/0001_backfill_email_confirmed.sql:1-10`
   - `update auth.users set email_confirmed_at = now() where email_confirmed_at is null and created_at < '2026-09-20';`
   - 仅在开启 email_confirm 后老用户登录受阻时执行
   - 对应 AC-12

## Workspace setup

- 实施前运行 `git status --short` 和 `git branch --show-current`
- ✅ 已完成:Phase 0 已创建 worktree `C:\Users\王俊澄\Desktop\food-register-email-verification`,分支 `codex/register-email-verification`,基于 HEAD `149efe6`
- 原工作区 `food` 的 dirty 改动(material-library/inspiration)不受影响
- 后续 dev-tdd 直接在此 worktree 内进行,无需再开

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Supabase Dashboard 配置项不可版本化,部署新环境遗漏 | runbook 记录全部配置项 + 部署前检查清单(AC-3/AC-13);CI 加部署后 smoke test 检查 `/register` 页是否包含 OTP 字段 |
| 邮箱枚举:`signUp` 返回 user_already_registered 暴露已注册邮箱 | 文案统一返回"验证码已发送"(实际不发送),引导用户去邮箱;但 spec 要求不暴露,需在 handleSendCode 把 user_already_registered 也当成功处理(不切 step,提示去登录) |
| 限流参数与原方案"10分钟5次邮箱/10次IP"不完全匹配 | Supabase Dashboard → Auth → Rate Limits 调整;若 Dashboard 不支持精确数字,接受 Supabase 默认值(通常更严格),在 runbook 记录实际值 |
| 生产 SMTP 未配置导致用户收不到邮件 | 部署前检查清单强制项;开发环境用 Supabase 默认邮件(3 封/小时配额) |
| 刷新页面丢失 step 状态,用户需重新 signUp | 接受此行为(与原方案"刷新页面"测试场景一致);UX 上 step='code-sent' 时提示"如未收到邮件,可重新获取";若用户回 idle 改邮箱,需重新 signUp(可能触发已注册错误,正常) |
| OTP 6 格子组件无障碍(a11y)未在 spec 要求 | 仍实现基础 a11y(aria-label / 键盘导航),不增加成本 |
| verifyOtp 成功但 router.push 前 onAuthStateChange 未及时触发 | AuthProvider 已订阅 onAuthStateChange,verifyOtp 成功后 Supabase 客户端会立即触发;router.push 不依赖 session 已更新(只要 verifyOtp 无 error 即跳转) |
| 开发环境 Supabase 默认邮件配额(3 封/小时)耗尽 | 开发时用同一邮箱测试,或配置开发环境 SMTP;runbook 记录 |
| 老用户 email_confirmed_at 为 null 登录受阻 | 补齐 SQL(AC-12 可选);部署前先跑 SQL 再开启 email_confirm |

## Verification steps

- AC-1: 手动访问 `/register`,DOM 检查含 3 个 input(email/password/otp)
- AC-2: 点击"获取验证码",观察按钮文案变为"60s 后重新获取"且 disabled
- AC-3: 检查 `docs/runbooks/supabase-auth-config.md` 含 Dashboard 配置截图/步骤
- AC-4: 浏览器 DevTools Network 检查 signUp 响应 `session: null`
- AC-5: 输入正确 OTP,观察跳转 `/dashboard` 且 AuthProvider session 已更新
- AC-6: 输入错误 OTP,观察错误提示"验证码错误",URL 仍 `/register`
- AC-7: 等待 5+ 分钟后输入 OTP,观察"验证码已过期"
- AC-8: 60s 内点击"重新发送",观察 disabled 不触发请求
- AC-9: 断网或 Supabase 邮件服务故障,观察"邮件发送失败"
- AC-10: 访问 `/login`,手动登录,确认跳转 `/dashboard`(回归测试)
- AC-11: 用已有账号(email_confirmed_at 已填充)登录,确认成功
- AC-12: (可选)执行补齐 SQL,用 email_confirmed_at=null 的账号登录
- AC-13: 部署前检查 Supabase Dashboard SMTP Settings 已配
- `npx tsc --noEmit`:TypeScript 零错误
- `npm test`:新增单元测试全通过(use-countdown + OtpInput + register page 错误映射)

## Pre-mortem (deliberate)

1. **Scenario**: Supabase Dashboard 配置遗漏,email_confirm 未开启
   **Trigger**: 部署到新环境时忘记在 Dashboard 开启 email_confirm
   **Mitigation**: runbook 部署前检查清单;CI 部署后 smoke test:用测试邮箱调 signUp,检查响应 session 是否为 null(若非 null 则配置错误,报警)

2. **Scenario**: verifyOtp 成功但用户未跳转 /dashboard
   **Trigger**: AuthProvider onAuthStateChange 未触发,或 router.push 在 session 更新前调用导致 middleware 重定向回 /register
   **Mitigation**: handleVerify 在 verifyOtp 无 error 后立即 router.push,不依赖 session 已更新(Next.js 客户端导航不经过 middleware);若仍卡,加 `await supabase.auth.getSession()` 确认 session 后再 push

3. **Scenario**: 邮箱枚举攻击,攻击者用 send-code 接口批量探测已注册邮箱
   **Trigger**: signUp 返回 user_already_registered,前端文案暴露"已注册"
   **Mitigation**: handleSendCode 对 user_already_registered 错误不切 step='code-sent',而是显示"如果该邮箱未注册,将发送验证码;如已注册请直接登录";不区分已注册/未注册文案( spec 第十三条要求)

## Expanded test plan (deliberate)

- **Unit**:
  - `hooks/use-countdown.test.ts`:start 后 seconds 递减 / 到 0 停止 / 组件卸载清理 interval
  - `components/auth/otp-input.test.tsx`:6 格输入 / 自动跳格 / 粘贴整段 / Backspace 回退 / maxLength 强制 / a11y aria-label
  - `app/register/page.test.tsx`:handleSendCode 错误映射(user_already_registered / rate_limit / 网络错误)/ handleVerify 错误映射(otp_expired / invalid_otp)/ handleResend 60s 内 disabled / step 切换
- **Integration**:
  - `app/register/register.integration.test.tsx`:完整流程 mock Supabase client,signUp→verifyOtp→session 更新→router.push;signUp 失败→错误提示;verifyOtp 失败→不跳转
- **E2E**(手动 + 可选 Playwright):
  - 正常注册:新邮箱→收 OTP→输入→跳 /dashboard
  - 错误 OTP→不跳转
  - 过期 OTP→提示
  - 60s 内重发→disabled
  - 老用户登录回归
  - /login 页完全不变
- **Observability**:
  - 前端 console.error 捕获 signUp/verifyOtp/resend 错误(开发环境)
  - 生产环境:Supabase Dashboard → Auth → Users 可查看注册用户 + email_confirmed_at
  - Supabase Dashboard → Auth → Logs 可查看 OTP 发送/验证日志
  - 可选:前端加 Sentry/ErrorBoundary 捕获注册流程异常(后续 backlog)

## ADR

- **Decision**: 复用 Supabase 原生 Email OTP,单页 state machine 前端直调,不自建表不自建 Service 不新增 API route
- **Drivers**: 上线时间(高)/ 维护成本(高)/ 安全合规(高)起决定性作用;用户体验(中)通过两步式 state machine 平衡
- **Alternatives considered**:
  - Option A(单页 state machine + 前端直调)— **chosen**,最小改动,与现有 Supabase 客户端模式一致
  - Option B(拆两页 + API route 代理)— **rejected**,改动面大 2-3 倍,API route 是多余抽象,两页跳转增加用户流失
  - Option C(自建 OTP 服务)— **rejected**(ADR 0001)
- **Why chosen**: Option A 满足 spec 全部 13 条 AC + 全部安全要求,改动面最小(1 页改 + 1 组件新 + 1 hook 新 + 1 runbook 新),零后端代码零新依赖,与 ADR 0001 完全一致
- **Consequences**:
  - 正面:上线快、维护成本低、安全责任由 Supabase 承担、与现有架构一致
  - 负面:Supabase Dashboard 配置不可版本化(由 runbook 缓解);限流参数不可精确控制(由 Dashboard 配置缓解);OTP 邮件模板定制受限于 Supabase 邮件编辑器
- **Follow-ups**:
  - 生产 SMTP Provider 选型(Resend 推荐,spec OQ-1)
  - 自定义 OTP 邮件模板品牌化(Supabase Dashboard 邮件模板编辑器)
  - 未来扩展 LOGIN/RESET_PASSWORD OTP(复用同一机制)
  - E2E 自动化测试(Playwright,本次手动 E2E)
  - Sentry/ErrorBoundary 前端异常监控(backlog)

## Review trail

- **Planner draft v1**: 列 Option A(单页)/ Option B(两页+API route)/ Option C(自建,ADR 拒绝),favored A。Implementation steps 9 步, cite 文件路径 + 行号。
- **Architect challenge v1**:
  - Steelman against A:单页 state machine 若用户刷新页面丢失 step 状态,需重新 signUp,可能触发"已注册"错误,UX 差。
  - Tradeoff tension:单页简洁 vs 两步式 UX 清晰;前端直调 vs API route 代理(限流/日志)。
  - Synthesis:单页内用 state machine 切 step(不拆 route),实现两步式 UX 但保留单页简洁;前端直调(无 API route,Supabase 已有限流)。
- **Critic verdict v1**: REVISE — 邮箱枚举防护 mitigation 不够具体(只说"文案统一"但没说 handleSendCode 怎么处理 user_already_registered);OtpInput a11y 未在实施步骤体现;Workspace setup 未确认 worktree 已存在。
- **Planner draft v2**:
  - handleSendCode 对 user_already_registered 不切 step,显示"如未注册将发送验证码;已注册请直接登录"(Pre-mortem scenario 3 + Risks 表)
  - OtpInput 实施步骤加 a11y 要求(aria-label / 键盘导航)
  - Workspace setup 确认 worktree 已存在(Phase 0 已建)
- **Architect challenge v2**: 同意 v2 修复,无新 tension。
- **Critic verdict v2**: APPROVED with 2 reservations(见下)。
- **Final iterations**: 2 / 3

### Critic reservations (v2 APPROVED 仍保留)

1. **限流参数不可版本化**:Supabase Dashboard 的 OTP 限流参数(email 频率/IP 频率/错误次数)不能进 git,部署到新环境需手动重配。runbook 记录是缓解但非根治;若未来需多环境一致性,考虑迁出自建。当前接受。
2. **OTP 邮件模板品牌化受限**:Supabase 邮件模板编辑器能力有限,若产品需要深度品牌化(多语言/动态内容/A/B 测试),需重新评估本 ADR。当前 spec 未要求,接受。

---

## 开发阶段任务拆分(对应原方案 Phase 1-4)

(注:dev-plan 不调度下游 skill,此处仅列建议,由用户决定是否进 dev-tdd)

- **Phase 1 验证码后端**: Supabase Dashboard 配置(runbook 记录)+ 零后端代码(方案 A 无后端改造)
- **Phase 2 前端**: `hooks/use-countdown.ts` + `components/auth/otp-input.tsx` + `app/register/page.tsx` 改造
- **Phase 3 安全限制**: 全部由 Supabase 原生承担,前端实现 60s 倒计时 + 错误码映射 + 邮箱枚举防护文案
- **Phase 4 测试**: Unit(use-countdown / OtpInput / register page)+ Integration(mock Supabase)+ E2E(手动 17 场景)
