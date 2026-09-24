-- ============================================================
-- 0013_recharge_orders.sql
-- 充值订单 + 收款码配置（人工收款模式）
--
-- 本阶段**不接任何第三方支付平台**。系统的职责边界很清楚：
--   用户提交金额 → 系统给一个订单号和一张收款码 → 用户自己去付款
--   → 用户说"我付了" → **管理员人工核账** → 才加积分
--
-- 因此这里有一条与支付平台完全不同的规则必须写进代码：
--   **PAID 不等于已到账。**
--   PAID 只是用户单方面声称"我付了"，它是流程状态，不是资金事实。
--   只有 CONFIRMED 才允许产生积分，且积分来自**管理员填写的实际到账金额**，
--   而不是用户提交的申请金额——多付、少付、付错都以管理员核实的为准。
--
-- 状态机（终态不可回退，见 trigger 前的校验）：
--   PENDING ──用户点"我已付款"──► PAID ──管理员确认──► CONFIRMED
--      │                            │
--      └──用户取消──► CANCELLED     └──管理员拒绝──► REJECTED
-- ============================================================

-- ─── 1. 收款码配置（单行表）───────────────────────────────────
-- 收款方式 / 二维码 / 说明：管理员在后台改这一行，全站立即生效。
-- 二维码可以是 Storage 公网 URL、对象存储链接或任何图片地址；
-- 本阶段不做任何支付回调或自动核账。
create table if not exists public.payment_settings (
  id           smallint primary key default 1 check (id = 1),
  method       text not null default '微信',
  qr_image_url text,
  account_name text,
  instruction  text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid
);

comment on table public.payment_settings is
  '收款码配置（单行）：method 收款方式 / qr_image_url 二维码 / instruction 收款说明；仅 service_role 可写';

insert into public.payment_settings (id, method, instruction)
values (1, '微信', '请使用微信扫描下方二维码付款，付款后点击「我已付款」，等待管理员确认到账。')
on conflict (id) do nothing;

alter table public.payment_settings enable row level security;

-- 充值页必须能读到收款码，所以放开读；写只给 service_role
drop policy if exists "payment_settings_select_all" on public.payment_settings;
create policy "payment_settings_select_all"
  on public.payment_settings for select to authenticated using (true);

grant select on public.payment_settings to authenticated;
grant select, insert, update on public.payment_settings to service_role;

-- ─── 2. 充值上限配置 ──────────────────────────────────────────
-- 人工审核模式下，一笔巨额充值大概率是输错了（多打一个 0）。
-- 给个上限，超限走线下沟通，比事后发现账错了再修便宜得多。
insert into public.point_config (key, value) values
  ('MAX_RECHARGE_AMOUNT', 5000)
on conflict (key) do nothing;

-- ─── 3. 充值订单 ──────────────────────────────────────────────
create table if not exists public.recharge_orders (
  id               uuid primary key default gen_random_uuid(),
  order_no         text not null unique,
  user_id          uuid not null references auth.users(id) on delete cascade,
  requested_amount numeric(10, 2) not null check (requested_amount > 0),
  -- 管理员核实的**实际到账金额**（元）；未确认前为 null
  confirmed_amount numeric(10, 2),
  -- 实际入账积分：由服务端按 confirmed_amount × POINTS_PER_YUAN 算出
  points           numeric(14, 2),
  status           text not null default 'PENDING'
                   check (status in ('PENDING','PAID','CONFIRMED','CANCELLED','REJECTED')),
  user_note        text,
  admin_note       text,
  created_at       timestamptz not null default now(),
  paid_at          timestamptz,
  confirmed_at     timestamptz,
  confirmed_by     uuid,
  -- 同一用户短时间内重复提交同金额订单是误操作的典型特征，用它做前端去重提示
  updated_at       timestamptz not null default now()
);

comment on table public.recharge_orders is
  '充值订单：requested_amount 是用户申请，confirmed_amount 是管理员核实的实际到账；积分只在 CONFIRMED 时按实际到账计算';
comment on column public.recharge_orders.status is
  'PENDING=已申请待付款 / PAID=用户声称已付款（**不代表已到账**） / CONFIRMED=管理员已确认到账 / CANCELLED=用户取消 / REJECTED=管理员未收到款';

create index if not exists recharge_orders_user_idx
  on public.recharge_orders (user_id, created_at desc);
create index if not exists recharge_orders_status_idx
  on public.recharge_orders (status, created_at desc);

alter table public.recharge_orders enable row level security;

-- 用户只能看自己的订单；**不给 UPDATE 策略**——改状态必须走 RPC，
-- 否则用户可以把自己的订单直接 update 成 CONFIRMED（那等于自助充钱）
drop policy if exists "recharge_orders_select_own" on public.recharge_orders;
create policy "recharge_orders_select_own"
  on public.recharge_orders for select to authenticated using (auth.uid() = user_id);

grant select on public.recharge_orders to authenticated;
grant select, insert, update on public.recharge_orders to service_role;

-- ─── 4. 状态机守卫：终态不可回退 ──────────────────────────────
-- 放在数据库里而不是应用代码里，是为了挡住「并发点两次确认」以外的
-- 另一类事故：管理员手工改数据、脚本批量更新、将来新接口忘了校验。
create or replace function public.recharge_guard_status()
returns trigger
language plpgsql
as $$
declare
  v_old text := old.status;
  v_new text := new.status;
begin
  if v_old = v_new then
    return new;
  end if;
  if v_old in ('CONFIRMED','CANCELLED','REJECTED') then
    raise exception 'recharge_order % 已处于终态 %，不可变更为 %', old.id, v_old, v_new
      using errcode = 'P0001';
  end if;
  if v_old = 'PENDING' and v_new not in ('PAID','CANCELLED','CONFIRMED','REJECTED') then
    raise exception 'PENDING 只能流转到 PAID / CANCELLED / CONFIRMED / REJECTED';
  end if;
  if v_old = 'PAID' and v_new not in ('CONFIRMED','REJECTED','CANCELLED') then
    raise exception 'PAID 只能流转到 CONFIRMED / REJECTED / CANCELLED';
  end if;
  return new;
end;
$$;

drop trigger if exists recharge_orders_status_guard on public.recharge_orders;
create trigger recharge_orders_status_guard
  before update of status on public.recharge_orders
  for each row execute function public.recharge_guard_status();

-- ─── 5. 创建充值订单 ──────────────────────────────────────────
-- 服务端校验金额上下限（读配置，不信任前端传来的任何"预计积分"）。
-- 返回订单行（含 order_no），前端据此展示收款码。
create or replace function public.create_recharge_order(
  p_amount numeric,
  p_note   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_uid    uuid := auth.uid();
  v_min    numeric;
  v_max    numeric;
  v_amount numeric;
  v_row    public.recharge_orders;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;

  v_amount := coalesce(p_amount, 0);
  v_min := public.point_config_num('MIN_RECHARGE_AMOUNT', 5);
  v_max := public.point_config_num('MAX_RECHARGE_AMOUNT', 5000);

  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'bad_amount');
  end if;
  if v_amount < v_min then
    return jsonb_build_object('ok', false, 'code', 'below_min', 'min', v_min);
  end if;
  if v_amount > v_max then
    return jsonb_build_object('ok', false, 'code', 'above_max', 'max', v_max);
  end if;

  insert into public.recharge_orders (order_no, user_id, requested_amount, user_note, status)
  values (
    'RC' || to_char(now(), 'YYMMDD') || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
    v_uid,
    round(v_amount, 2),
    nullif(trim(coalesce(p_note, '')), ''),
    'PENDING'
  )
  returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'order', jsonb_build_object(
      'id', v_row.id,
      'orderNo', v_row.order_no,
      'requestedAmount', v_row.requested_amount,
      'status', v_row.status,
      'createdAt', v_row.created_at
    )
  );
end;
$$;

comment on function public.create_recharge_order(numeric, text) is
  '创建充值订单：金额下限/上限由 point_config 控制，订单初始状态 PENDING';

grant execute on function public.create_recharge_order(numeric, text) to authenticated;

-- ─── 6. 用户标记「我已付款」：PENDING → PAID ───────────────────
-- 这里**只改状态，绝不加积分**。用户说付了，不代表钱到了。
create or replace function public.mark_recharge_paid(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_uid   uuid := auth.uid();
  v_row   public.recharge_orders;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;

  select * into v_row
  from public.recharge_orders
  where id = p_order_id and user_id = v_uid
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.status <> 'PENDING' then
    -- 重复点「我已付款」不是错误，直接回当前状态（幂等）
    return jsonb_build_object('ok', true, 'status', v_row.status, 'changed', false);
  end if;

  update public.recharge_orders
    set status = 'PAID', paid_at = now(), updated_at = now()
    where id = p_order_id;

  return jsonb_build_object('ok', true, 'status', 'PAID', 'changed', true);
end;
$$;

comment on function public.mark_recharge_paid(uuid) is
  '用户声称已付款：PENDING→PAID，**不加积分**；重复调用幂等';

grant execute on function public.mark_recharge_paid(uuid) to authenticated;

-- ─── 7. 用户取消订单 ──────────────────────────────────────────
-- 已确认的订单不能取消（钱都到账了），已拒绝/已取消的走终态守卫。
create or replace function public.cancel_recharge_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.recharge_orders;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;

  select * into v_row
  from public.recharge_orders
  where id = p_order_id and user_id = v_uid
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.status = 'CANCELLED' then
    return jsonb_build_object('ok', true, 'status', 'CANCELLED', 'changed', false);
  end if;
  if v_row.status in ('CONFIRMED','REJECTED') then
    return jsonb_build_object('ok', false, 'code', 'already_closed', 'status', v_row.status);
  end if;

  update public.recharge_orders
    set status = 'CANCELLED', updated_at = now()
    where id = p_order_id;

  return jsonb_build_object('ok', true, 'status', 'CANCELLED', 'changed', true);
end;
$$;

comment on function public.cancel_recharge_order(uuid) is
  '用户取消自己的充值订单；已确认/已拒绝的订单不可取消';

grant execute on function public.cancel_recharge_order(uuid) to authenticated;

-- ─── 8. 验证查询 ──────────────────────────────────────────────
--   select public.create_recharge_order(10);          -- ok：10 元订单
--   select public.create_recharge_order(1);           -- below_min
--   select public.mark_recharge_paid('<order_id>');   -- PENDING→PAID，积分不变
--   select order_no, requested_amount, confirmed_amount, points, status
--     from public.recharge_orders order by created_at desc limit 10;
