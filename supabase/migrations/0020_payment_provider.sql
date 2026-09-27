-- ============================================================
-- 0020_payment_provider.sql
-- 支付层预留 + 充值档位配置化 + confirm_recharge 幂等补强
--
-- 三件事，全是"补缺口"，不动已有结构：
--
--   ① recharge_orders.provider
--      需求 §18：支付层必须与订单/账本/余额解耦，MVP 用 ManualPaymentProvider，
--      未来 WechatPayProvider / AlipayProvider 只替换"支付确认方式"。
--      订单上记一行 provider，将来就能回答"这笔钱是从哪条通道进来的"，
--      而不用重新设计积分系统。现在只有 MANUAL 一种，**将来加值时改 check 约束即可**。
--
--   ② payment_settings.quick_amounts
--      需求 §4「不要把充值比例散落在前端代码中」。此前快捷档位 [5,10,20,50,100]
--      是写死在页面里的常量——改档位要发版。挪进这张单行配置表后，
--      管理员在后台改完即生效。
--
--   ③ confirm_recharge 的幂等补强
--      原实现在"流水已存在但订单未确认"时会直接返回 duplicated 而不动订单，
--      形成一个永久楔子：订单永远停在 PAID，管理员点几次都是同一句话。
--      正常路径下撞不到（加积分与改订单在同一个事务里），但这属于
--      「一旦发生就没有出路」的状态，必须留修复路径：
--      流水存在就证明积分已经入过账，这里把订单补齐到 CONFIRMED，
--      让订单如实反映账目，而不是继续挂着让人反复点。
-- ============================================================

-- ─── 1. 订单记录支付通道 ────────────────────────────────────
alter table public.recharge_orders
  add column if not exists provider text not null default 'MANUAL';

-- 现阶段只接受 MANUAL；将来接正式支付时，把新值加进这个 check 即可
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'recharge_orders_provider_check'
      and conrelid = 'public.recharge_orders'::regclass
  ) then
    alter table public.recharge_orders
      add constraint recharge_orders_provider_check
      check (provider in ('MANUAL'));
  end if;
end;
$$;

comment on column public.recharge_orders.provider is
  '支付通道：MANUAL=管理员收款码人工确认；未来接入 WECHAT/ALIPAY 时在此扩展，订单与账本结构不变';

-- ─── 2. 快捷充值档位（配置化，不在前端写死）────────────────
alter table public.payment_settings
  add column if not exists quick_amounts numeric[] not null default '{5,10,20,50,100}';

comment on column public.payment_settings.quick_amounts is
  '充值页快捷金额档位（元）；管理员在后台改这里即生效，前端不得硬编码';

-- ─── 3. confirm_recharge：撞到流水唯一索引时把订单补齐到终态 ─
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
  if not public.is_service_caller() then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;

  v_amount := round(coalesce(p_amount, 0), 2);
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'bad_amount');
  end if;

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
    -- 幂等③：流水已经存在，说明这笔积分早就入过账了。
    -- 正常情况下订单此刻必然是 CONFIRMED（加积分与改订单在同一事务里），
    -- 走不到这里。万一走到了，就把订单补齐到终态——账已经在了，
    -- 订单不能继续挂 PAID 让管理员反复点、反复得到同一句"已处理过"。
    select amount into v_dup
    from public.point_ledger
    where user_id = v_row.user_id and type = 'RECHARGE' and reference_id = v_row.order_no
    limit 1;

    if v_row.status in ('PENDING', 'PAID') then
      update public.recharge_orders
        set status = 'CONFIRMED',
            confirmed_amount = v_amount,
            points = coalesce(v_dup, 0),
            confirmed_at = now(),
            confirmed_by = p_admin_id,
            admin_note = coalesce(nullif(trim(coalesce(p_note, '')), ''), admin_note),
            updated_at = now()
        where id = p_order_id;
    end if;

    return jsonb_build_object(
      'ok', true, 'duplicated', true,
      'points', coalesce(v_dup, 0), 'balance', v_before
    );
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

-- ─── 4. 验证查询 ────────────────────────────────────────────
--   select provider, count(*) from public.recharge_orders group by provider;
--     -- 期望：全部 MANUAL
--   select quick_amounts from public.payment_settings where id = 1;
--     -- 期望：{5,10,20,50,100}
