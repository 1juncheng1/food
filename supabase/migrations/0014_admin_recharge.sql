-- ============================================================
-- 0014_admin_recharge.sql
-- 管理员体系 + 确认到账 + 手动调分
--
-- 这是整个积分系统里**唯一能凭空产生积分**的地方，所以它的每一条
-- 规则都必须是"默认拒绝"的：
--
--   · 管理员身份来自 admin_users 白名单表（不是某个布尔字段，不是 env 里的邮箱）
--   · 确认到账只允许 service_role 调用（普通用户 token 进来一律 forbidden）
--   · 积分由**实际到账金额**算出，管理员传金额、不传积分
--   · 幂等有三重：订单状态、流水唯一索引、余额行锁
--
-- 一个订单只能产生一条 RECHARGE 流水。管理员手抖点两次「确认到账」，
-- 第二次要么撞上终态守卫（已经是 CONFIRMED）、要么撞上流水唯一索引，
-- 两条路都是零副作用。
-- ============================================================

-- ─── 1. 管理员白名单 ────────────────────────────────────────
-- 为什么是表而不是 users 表上的布尔列：
--   管理员的增删是**运营动作**，需要留痕（谁把谁设成管理员、什么时候），
--   也需要支持多人。塞在 auth.users 的 metadata 里既查不动也审不了。
create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid
);

comment on table public.admin_users is
  '管理员白名单：只有在这里的用户才能进入后台做确认到账 / 手动调分 / 改配置';

alter table public.admin_users enable row level security;

-- 用户只能知道自己是不是管理员（前端据此决定要不要展示后台入口）
drop policy if exists "admin_users_select_self" on public.admin_users;
create policy "admin_users_select_self"
  on public.admin_users for select to authenticated using (auth.uid() = user_id);

grant select on public.admin_users to authenticated;
grant select, insert, delete on public.admin_users to service_role;

-- 判定"我是不是管理员"：被 RLS 策略复用的小函数（必须 STABLE，不能是 VOLATILE）
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select exists (
    select 1 from public.admin_users a where a.user_id = auth.uid()
  );
$$;

comment on function public.is_admin() is '当前登录用户是否为管理员（RLS 策略与后台入口共用同一个判断）';

grant execute on function public.is_admin() to authenticated, service_role;

-- ─── 2. 管理员读权限：跨用户查看订单 / 流水 / 余额 ────────────
-- 管理员必须能看到别人的订单才能核账；但**写**仍然只走 RPC。
drop policy if exists "recharge_orders_select_admin" on public.recharge_orders;
create policy "recharge_orders_select_admin"
  on public.recharge_orders for select to authenticated using (public.is_admin());

drop policy if exists "point_ledger_select_admin" on public.point_ledger;
create policy "point_ledger_select_admin"
  on public.point_ledger for select to authenticated using (public.is_admin());

drop policy if exists "user_balances_select_admin" on public.user_balances;
create policy "user_balances_select_admin"
  on public.user_balances for select to authenticated using (public.is_admin());

-- ─── 3. 确认到账（唯一能产生充值积分的入口）─────────────────
create or replace function public.confirm_recharge(
  p_order_id uuid,
  p_amount   numeric,
  p_admin_id uuid,
  p_note     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_row     public.recharge_orders;
  v_ppy     numeric;
  v_amount  numeric;
  v_points  numeric;
  v_before  numeric;
  v_after   numeric;
  v_dup     numeric;
begin
  -- 只允许服务端可信通道：管理员身份在 Node 层（admin_users）已校验过
  if not public.is_service_caller() then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;

  v_amount := round(coalesce(p_amount, 0), 2);
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'bad_amount');
  end if;

  -- 锁订单：两个管理员同时点确认时，第二个在这里等
  select * into v_row
  from public.recharge_orders
  where id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  -- 幂等①：已确认的订单直接返回上次结果（重复点「确认到账」零副作用）
  if v_row.status = 'CONFIRMED' then
    select balance_after into v_dup
    from public.point_ledger
    where type = 'RECHARGE' and reference_id = v_row.order_no
    limit 1;
    return jsonb_build_object(
      'ok', true, 'duplicated', true,
      'points', v_row.points, 'balance', coalesce(v_dup, 0)
    );
  end if;

  if v_row.status in ('CANCELLED', 'REJECTED') then
    return jsonb_build_object('ok', false, 'code', 'already_closed', 'status', v_row.status);
  end if;

  v_ppy := public.point_config_num('POINTS_PER_YUAN', 20);
  -- 向下取整：宁可少给 1 积分，也不因浮点尾巴多送
  v_points := floor(v_amount * v_ppy);

  insert into public.user_balances (user_id, balance)
  values (v_row.user_id, 0)
  on conflict (user_id) do nothing;

  select balance into v_before
  from public.user_balances
  where user_id = v_row.user_id
  for update;

  v_before := coalesce(v_before, 0);
  v_after  := v_before + v_points;

  -- 幂等②：同一订单号只能有一条 RECHARGE 流水（物理约束，撞上即已处理）
  insert into public.point_ledger
    (user_id, type, amount, balance_before, balance_after, source, reference_id, description, created_by)
  values
    (v_row.user_id, 'RECHARGE', v_points, v_before, v_after, 'recharge', v_row.order_no,
     '充值到账：实际到账 ' || v_amount || ' 元（订单 ' || v_row.order_no || '）', p_admin_id)
  on conflict (user_id, type, reference_id) where reference_id is not null do nothing;

  if not found then
    return jsonb_build_object('ok', true, 'duplicated', true, 'points', 0, 'balance', v_before);
  end if;

  update public.user_balances
    set balance = v_after, updated_at = now()
    where user_id = v_row.user_id;

  update public.recharge_orders
    set status = 'CONFIRMED',
        confirmed_amount = v_amount,
        points = v_points,
        confirmed_at = now(),
        confirmed_by = p_admin_id,
        admin_note = nullif(trim(coalesce(p_note, '')), ''),
        updated_at = now()
    where id = p_order_id;

  return jsonb_build_object(
    'ok', true, 'duplicated', false,
    'points', v_points, 'balance', v_after,
    'confirmedAmount', v_amount
  );
end;
$$;

comment on function public.confirm_recharge(uuid, numeric, uuid, text) is
  '管理员确认充值到账：按实际到账金额计算积分并写流水；重复确认只生效一次';

grant execute on function public.confirm_recharge(uuid, numeric, uuid, text) to service_role;

-- ─── 4. 拒绝到账 ────────────────────────────────────────────
-- 没收到款 / 付款信息对不上：只改状态，**一分不加**。
create or replace function public.reject_recharge(
  p_order_id uuid,
  p_admin_id uuid,
  p_note     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_row public.recharge_orders;
begin
  if not public.is_service_caller() then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;

  select * into v_row
  from public.recharge_orders
  where id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if v_row.status = 'REJECTED' then
    return jsonb_build_object('ok', true, 'duplicated', true, 'status', 'REJECTED');
  end if;

  if v_row.status in ('CONFIRMED', 'CANCELLED') then
    return jsonb_build_object('ok', false, 'code', 'already_closed', 'status', v_row.status);
  end if;

  update public.recharge_orders
    set status = 'REJECTED',
        confirmed_at = now(),
        confirmed_by = p_admin_id,
        admin_note = nullif(trim(coalesce(p_note, '')), ''),
        updated_at = now()
    where id = p_order_id;

  return jsonb_build_object('ok', true, 'duplicated', false, 'status', 'REJECTED');
end;
$$;

comment on function public.reject_recharge(uuid, uuid, text) is
  '管理员拒绝充值（未收到款）：只改状态，不增加积分';

grant execute on function public.reject_recharge(uuid, uuid, text) to service_role;

-- ─── 5. 验证查询 ────────────────────────────────────────────
--   -- 把某个用户设为管理员（**第一个管理员只能这样手动建**）。
--   -- user_id 是 uuid 且外键指向 auth.users(id)，所以**不能直接写字面量邮箱**，
--   -- 必须先换成真实 UUID（形如 3f2a...-...-...）。按邮箱一次到位：
--   insert into public.admin_users (user_id)
--     select id from auth.users
--     where lower(trim(email)) = lower('you@example.com')
--     on conflict (user_id) do nothing;
--
--   -- 只有 UUID 时用这条（把下面的值换成上一步查到的真实 UUID）：
--   -- insert into public.admin_users (user_id)
--   --   values ('3f2a0000-0000-0000-0000-000000000000')
--   --   on conflict (user_id) do nothing;
--
--   -- 查自己的 UUID：select id, email from auth.users order by created_at desc limit 20;
--
--   select public.confirm_recharge('<order_id>', 10, '<admin_user_id>', '已核对');
--   select public.confirm_recharge('<order_id>', 10, '<admin_user_id>', '再点一次');  -- duplicated:true
--   select public.reject_recharge('<order_id>', '<admin_user_id>', '未收到');
--
--   select l.type, l.amount, l.balance_before, l.balance_after, l.reference_id, l.created_at
--     from public.point_ledger l order by l.created_at desc limit 20;
