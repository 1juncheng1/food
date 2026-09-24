-- ============================================================
-- 0007_user_balance.sql
-- 用户账户余额：每用户一行，记录可用于 AI 生成的额度
--
-- 一句话：把「这个用户还能不能生成」从"猜"变成"查"。
--
-- 为什么是独立表，而不是给 style_profiles 加一列：
--   1. 语义不同——style_profiles 是**创作风格档案**（语气标签/节奏/人格偏好），
--      余额是**账户资金**。把钱写进风格表，等于让"余额"随风格行一起被
--      「重新统计风格卡」这类 upsert 逻辑覆盖，风险不可控。
--   2. 权限不同——风格档案允许用户自己改（设置页编辑）；余额**绝不允许**
--      客户端自改，否则用户改一行 localStorage 之外的 SQL 就能无限白嫖。
--      独立表可以只给 SELECT，写权限只留给 security definer 函数。
--   3. 演进不同——余额必然会长出充值流水、扣费明细、套餐包。独立表才有
--      地方接这些，塞在风格表里会让一张表同时承担两种生命周期。
--
-- 设计要点：
--   · numeric(12,2) 而非 integer：余额可能按 token 计费出现小数，且金额
--     绝不能用浮点（binary float 累加会漂移，扣费场景是事故级问题）。
--   · check (balance >= 0)：不允许负余额，扣减只能在函数内原子判定。
--   · 客户端只有 SELECT 权限，无 INSERT/UPDATE/DELETE 策略——RLS 默认拒绝，
--     所以即使 grant 了表级写权限也会被策略挡住（双保险）。
--   · 「行不存在 == 余额 0」：新用户不该因缺一行而 500；扣费函数会按需补行。
--
-- 记账单位：**积分**（不是次数）。
--   汇率：20 积分 = ¥0.5 ⇒ 1 元 = 40 积分（唯一出处 lib/balance.ts 的
--   POINTS_PER_YUAN）。一次生成的扣费额 = 真实 token 成本 × 40，
--   所以余额能自然覆盖"300 字小稿"与"3000 字长文"的成本差异。
--
-- ⚠ 赠送额度可调：下方存量赠送与 ensure_balance() 的默认参数 20 是
--   「体验金」常量（20 积分 = ¥0.5）。若要新用户注册后必须充值才能用，
--   把它改成 0（两处都改，行为才一致）。
-- ============================================================

create table if not exists public.user_balances (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  balance    numeric(12, 2) not null default 0 check (balance >= 0),
  updated_at timestamptz   not null default now()
);

comment on table public.user_balances is
  '用户账户余额：每用户一行；balance 为可用积分（numeric 避免浮点漂移），客户端只读';
comment on column public.user_balances.balance is
  '可用积分；20 积分 = ¥0.5；0 表示无余额，生成入口应提示充值（由 consume_balance 按 token 用量原子扣减）';

alter table public.user_balances enable row level security;

-- 只允许本人读：RLS 未定义 INSERT/UPDATE/DELETE 策略 ⇒ 客户端写一律被拒
drop policy if exists "user_balance_select_own" on public.user_balances;
create policy "user_balance_select_own" on public.user_balances
  for select to authenticated using (auth.uid() = user_id);

grant select on public.user_balances to authenticated;

-- ── 存量用户：赠送 20 积分（= ¥0.5 体验金）────────────────
-- 不加这一段，迁移一跑完所有老用户余额都是 0、立刻全部无法生成。
-- 如需"存量用户也必须充值"，把 20 改成 0。
insert into public.user_balances (user_id, balance)
select id, 20 from auth.users
on conflict (user_id) do nothing;

-- ── ensure_balance：首次访问补行 + 返回当前余额 ────────────
-- security definer：需要越过"客户端无 INSERT 权限"的限制来建行；
-- 但函数内第一行就用 auth.uid() 取身份，用户无法为别人建行。
create or replace function public.ensure_balance(p_grant numeric default 20)
returns numeric
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_uid     uuid := auth.uid();
  v_balance numeric;
begin
  if v_uid is null then
    return null;
  end if;

  insert into public.user_balances (user_id, balance)
  values (v_uid, greatest(coalesce(p_grant, 0), 0))
  on conflict (user_id) do nothing;

  select balance into v_balance
  from public.user_balances
  where user_id = v_uid;

  return coalesce(v_balance, 0);
end;
$$;

comment on function public.ensure_balance(numeric) is
  '保证余额行存在（新用户赠送 p_grant 积分，默认 20 积分 = ¥0.5）并返回当前余额；未登录返回 null';

-- ── consume_balance：原子扣减（余额不足则不动账）────────────
-- 为什么必须用函数而不是"先 select 再 update"两趟请求：
--   两次请求之间存在竞态——用户狂点生成会并发读到同一份余额，
--   各自判定"够"再各扣一次，余额被击穿成负数。
--   for update 行锁 + 单条语句内判定，才是唯一正确的写法。
-- 返回 jsonb：{ ok:true, balance } / { ok:false, code, balance }
create or replace function public.consume_balance(p_amount numeric default 1)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_uid     uuid := auth.uid();
  v_amount  numeric := greatest(coalesce(p_amount, 1), 0);
  v_balance numeric;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;

  -- 行不存在时按 0 处理（新用户没赠额度 ⇒ 直接判定余额不足）
  insert into public.user_balances (user_id, balance)
  values (v_uid, 0)
  on conflict (user_id) do nothing;

  -- 行锁：并发扣费在这里排队，避免两份请求读到同一余额
  select balance into v_balance
  from public.user_balances
  where user_id = v_uid
  for update;

  if coalesce(v_balance, 0) < v_amount then
    return jsonb_build_object(
      'ok', false,
      'code', 'insufficient_balance',
      'balance', coalesce(v_balance, 0)
    );
  end if;

  update public.user_balances
  set balance = balance - v_amount,
      updated_at = now()
  where user_id = v_uid
  returning balance into v_balance;

  return jsonb_build_object('ok', true, 'balance', coalesce(v_balance, 0));
end;
$$;

comment on function public.consume_balance(numeric) is
  '原子扣减当前用户余额；余额不足返回 ok:false/code:insufficient_balance 且不动账';

grant execute on function public.ensure_balance(numeric) to authenticated;
grant execute on function public.consume_balance(numeric) to authenticated;

-- ── 验证查询 ────────────────────────────────────────────────
--   select user_id, balance from public.user_balances order by updated_at desc limit 10;
--   select public.ensure_balance();      -- 应返回当前用户余额
--   select public.consume_balance(0);    -- 应返回 ok:true 且余额不变（冒烟用）
