-- 历史用户 email_confirmed_at 补齐
-- 用途:开启 Supabase "Confirm email" 后,为 created_at 在 cutoff 之前但
--       email_confirmed_at 为 null 的老用户补齐确认时间,避免登录受阻
-- 执行条件:仅在开启 email_confirm 后老用户登录受阻时执行
-- 执行方式:Supabase Dashboard → SQL Editor,或 service_role 客户端
-- 安全性:幂等 —— 已有 email_confirmed_at 的用户不会被覆盖

update auth.users
set email_confirmed_at = coalesce(email_confirmed_at, now())
where email_confirmed_at is null
  and created_at < '2026-09-20';

-- 验证补齐结果
select
  count(*) filter (where email_confirmed_at is null) as still_unconfirmed,
  count(*) filter (where email_confirmed_at is not null) as confirmed
from auth.users;
