# Context

## Glossary

| Term | Meaning | Notes |
|---|---|---|
| Supabase managed auth | 用户表/密码哈希/邮箱验证/会话 全部由 Supabase 平台托管,代码层只调 `@supabase/supabase-js` API | 项目 `auth.users` 不在 `supabase/setup.sql` 中,由 Supabase 平台管理 |
| `auth.users` | Supabase 托管用户表,内置 `id`/`email`/`encrypted_password`/`email_confirmed_at` | 业务表通过 `user_id uuid references auth.users(id)` 关联 |
| `email_confirmed_at` | Supabase `auth.users` 内置字段,记录邮箱确认时间,null 表示未确认 | 开启 "Confirm email" 后,新用户必须完成确认才能拿到 session |
| Email OTP | Supabase 原生邮箱一次性验证码,6 位数字,通过邮件发送,前端调 `verifyOtp` 验证 | 与 magic link(链接确认)互斥,Dashboard 配置二选一 |
| `supabase.auth.signUp` | Supabase 注册 API,开启 email_confirm 后返回 `session=null` 等待确认 | 不能直接拿到登录态 |
| `supabase.auth.verifyOtp` | 验证 OTP API,签名 `verifyOtp({ email, token, type: 'signup' })`,成功返回 session | 注册场景 `type` 固定为 `'signup'` |
| `supabase.auth.resend` | 重发 OTP API,签名 `resend({ email, type: 'signup' })` | 受 60s 发送冷却限制 |
| Supabase Dashboard | Supabase 项目控制台,配置 email_confirm / OTP 模式 / SMTP / 限流 | 配置项不进 git,需在 runbook 记录 |
| Custom SMTP | 生产环境必须配置的第三方 SMTP(Resend/SendGrid/腾讯云/阿里云) | 开发环境可用 Supabase 默认邮件(3 封/小时配额) |
| 灵感卡 / Suggestion | 「AI 发现的创作机会」中的一条可创作选题推荐,落库于 interest_suggestions | 一条卡 = title/description/topic + slot + source + 五因子 score + AI 推荐理由;status: active/superseded |
| 画像 build / runBuild | 消费 creator_events 全量事件 → 聚类 → 评分 → 生成灵感卡队列的一次性重建过程 | interest_builds 记录 running/done/failed;每轮 build 开始会 supersede 旧卡 |
| 槽位 / slot | 卡的多样性分桶:core_gap / evidence_followup / exploration / continuation | selectSlots 按槽配额选卡;exploration=相邻兴趣探索 |
| 降级卡 / fallback | 无画像/队列空/游客/异常时展示的非个性化卡 | 必须诚实标注状态(WF10),不得伪装个性化 |
| 全局热点 / ci_items | 跨用户共享的市场情报表,CI 适配层(Tavily 等)抓取后写入 | 用户个性化读取走 S2 getMarketCandidates;冷启动全局流读 query_hash=global:v1:<date> |
| Feed 游标 | /api/inspirations/feed 的无状态分页标记(last_score+last_id+日种子) | 不落库;曝光/dismiss 去重以 creator_events 服务端记录为准 |
