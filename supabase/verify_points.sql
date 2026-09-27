-- ============================================================
-- verify_points.sql —— 积分系统端到端验收脚本（Phase 6）
--
-- 用法：Supabase SQL Editor 里按「① → ⑦」依次执行。
-- 全部是只读查询 + 幂等断言，**不会破坏数据**。
--
-- 每一节的期望结果写在注释里，任何一条不符都说明账目有问题，
-- 请停下排查，不要继续往下跑。
-- ============================================================


-- ── ① 迁移是否都跑了 ──────────────────────────────────────────
-- 期望：5 张表全部存在（user_balances 是 0007 建的，其余为本次新增）
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'user_balances', 'point_config', 'point_ledger',
    'recharge_orders', 'payment_settings', 'admin_users'
  )
order by table_name;
-- 期望返回 6 行


-- ── ② 价格配置快照 ────────────────────────────────────────────
-- 期望：POINTS_PER_YUAN=20、MIN_RECHARGE_AMOUNT=5、REGISTER_BONUS_POINTS=20
select key, value from public.point_config order by key;


-- ── ③ 注册赠送只发生一次 ──────────────────────────────────────
-- 期望：**每个用户最多 1 条** REGISTER_BONUS。出现 >=2 即为幂等失效。
select user_id, count(*) as bonus_count
from public.point_ledger
where type = 'REGISTER_BONUS'
group by user_id
having count(*) > 1;
-- 期望：0 行


-- ── ④ 账实相符：余额 == 流水累计 ──────────────────────────────
-- 这是整个系统最硬的一条断言：余额必须等于所有流水的代数和。
-- 期望：0 行（有行说明余额被绕过流水改过，或流水漏记）
select b.user_id, b.balance, coalesce(sum(l.amount), 0) as ledger_sum
from public.user_balances b
left join public.point_ledger l on l.user_id = b.user_id
group by b.user_id, b.balance
having b.balance <> coalesce(sum(l.amount), 0);
-- 期望：0 行


-- ── ⑤ 流水链不断档 ────────────────────────────────────────────
-- 每条流水的 balance_before 必须等于上一条的 balance_after。
-- 期望：0 行（有行说明并发下出现了丢失更新）
with ordered as (
  select user_id, balance_before, balance_after,
         lag(balance_after) over (partition by user_id order by created_at, id) as prev_after
  from public.point_ledger
)
select * from ordered
where prev_after is not null and balance_before <> prev_after;
-- 期望：0 行


-- ── ⑥ 没有负余额 / 没有负余额的流水终点 ───────────────────────
select user_id, balance from public.user_balances where balance < 0;
-- 期望：0 行
select id, user_id, balance_after from public.point_ledger where balance_after < 0;
-- 期望：0 行


-- ── ⑦ 一个订单只能产生一条 RECHARGE 流水 ──────────────────────
select reference_id, count(*) as recharge_count
from public.point_ledger
where type = 'RECHARGE' and reference_id is not null
group by reference_id
having count(*) > 1;
-- 期望：0 行


-- ── ⑧ 已确认订单的状态一致性 ──────────────────────────────────
-- CONFIRMED 的订单必须有 confirmed_amount / points / confirmed_at / confirmed_by
select id, order_no, status
from public.recharge_orders
where status = 'CONFIRMED'
  and (confirmed_amount is null or points is null or confirmed_at is null or confirmed_by is null);
-- 期望：0 行

-- 未确认的订单绝不能有积分
select id, order_no, status from public.recharge_orders
where status in ('PENDING', 'PAID', 'CANCELLED', 'REJECTED') and points is not null;
-- 期望：0 行


-- ============================================================
-- 以下 ⑨~⑫ 是**手工功能验收**，需要你用两个浏览器账号配合完成。
-- 执行前先把 <USER_ID> / <ORDER_ID> / <ADMIN_ID> 替换成真实值。
-- ============================================================

-- ── ⑨ 建第一个管理员 ──────────────────────────────────────────
-- user_id 是 uuid 且外键指向 auth.users(id)，**不能填邮箱、也不能留占位符**。
-- 按邮箱反查，一步到位（把 you@example.com 换成真实登录邮箱）：
--
--   insert into public.admin_users (user_id)
--     select id from auth.users
--     where lower(trim(email)) = lower('you@example.com')
--     on conflict (user_id) do nothing;
--   select a.user_id, u.email from public.admin_users a
--     left join auth.users u on u.id = a.user_id;


-- ── ⑩ 重复确认不会重复充值 ────────────────────────────────────
-- 用真实账号在 /recharge 下 10 元订单 → 点「我已付款」→ 到 /admin/recharge 确认 10 元。
-- 然后在 SQL Editor 里**连点两次**（把 <ORDER_ID> 换成真实订单 id）：
--
--   select public.confirm_recharge('<ORDER_ID>', 10, '<ADMIN_ID>', '已核对');
--   -- 第一次：ok=true, duplicated=false, points=200
--   select public.confirm_recharge('<ORDER_ID>', 10, '<ADMIN_ID>', '再点一次');
--   -- 第二次：ok=true, **duplicated=true**，积分不再变
--
-- 校验：该订单号在 point_ledger 里只有 1 条 RECHARGE
--   select * from public.point_ledger where reference_id = '<订单号>';


-- ── ⑪ 拒绝订单不加分 ──────────────────────────────────────────
--   select public.reject_recharge('<ORDER_ID>', '<ADMIN_ID>', '未收到款');
--   -- 期望：ok=true, status=REJECTED，且该订单在 point_ledger 里**没有任何**记录
--   select * from public.point_ledger where reference_id = '<订单号>';


-- ── ⑫ 多付/少付：按实际到账金额入账 ───────────────────────────
-- 用户申请 10 元、实际到账 20 元时，管理员填 20：
--   select public.confirm_recharge('<ORDER_ID>', 20, '<ADMIN_ID>', '实际收到 20');
--   -- 期望：points = 400（20 × POINTS_PER_YUAN），不是 200
--   select order_no, requested_amount, confirmed_amount, points, status
--     from public.recharge_orders where id = '<ORDER_ID>';
